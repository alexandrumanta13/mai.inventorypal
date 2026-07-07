import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ImportJob } from '../entities/import-job.entity';
import {
  ImportJobSourceType,
  ImportJobStatus,
  ImportSourceType,
} from '@shared/enums/import-source.enum';
import { EmailsService, CreateEmailDto } from '@modules/emails/services/emails.service';

interface JsonPageRecord {
  'Email address ▾': string;
  'First name ▾'?: string;
  'Last name ▾'?: string;
  'Phone ▾'?: string;
  'Country ▾'?: string;
  'City ▾'?: string;
  'Acquisition ▾'?: string;
  'Acquisition date ▾'?: string;
  'Funnel ▾'?: string;
}

@Injectable()
export class JsonImportService {
  private readonly logger = new Logger(JsonImportService.name);
  private readonly jsonPagesPath: string;
  private readonly batchSize: number;

  constructor(
    @InjectRepository(ImportJob)
    private readonly importJobRepository: Repository<ImportJob>,
    private readonly emailsService: EmailsService,
    private readonly configService: ConfigService,
  ) {
    this.jsonPagesPath = this.configService.get<string>('JSON_PAGES_PATH');
    this.batchSize = this.configService.get<number>('IMPORT_BATCH_SIZE', 10000);
  }

  /**
   * Start JSON import job (fires async process)
   */
  async startJsonImport(): Promise<ImportJob> {
    // Create import job
    const job = await this.importJobRepository.save({
      sourceType: ImportJobSourceType.JSON_PAGES,
      status: ImportJobStatus.PENDING,
    });

    // Fire and forget
    this.processJsonImport(job.id).catch((err) => {
      this.logger.error(`JSON import job ${job.id} failed: ${err.message}`, err.stack);
      this.markJobFailed(job.id, err.message);
    });

    return job;
  }

  /**
   * Process JSON import (async background)
   */
  private async processJsonImport(jobId: number): Promise<void> {
    this.logger.log(`Starting JSON import job ${jobId}`);

    // Mark job as running
    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.RUNNING,
      startedAt: new Date(),
    });

    // Get all JSON files
    const files = await this.getJsonFiles();
    const totalFiles = files.length;

    this.logger.log(`Found ${totalFiles} JSON files to process`);

    await this.importJobRepository.update(jobId, {
      totalFiles,
    });

    // Deduplication tracking (in-memory)
    const seenEmails = new Set<string>();
    let batch: CreateEmailDto[] = [];

    // Counters
    let processedFiles = 0;
    let totalRecords = 0;
    let importedEmails = 0;
    let duplicateEmails = 0;
    let invalidEmails = 0;

    // Process files sequentially (streaming approach)
    for (const file of files) {
      try {
        // Read and parse JSON file
        const content = await fs.readFile(file, 'utf-8');
        const records: JsonPageRecord[] = JSON.parse(content);

        totalRecords += records.length;

        // Process each record in the file
        for (const record of records) {
          const email = record['Email address ▾']?.trim().toLowerCase();
          const emailData: CreateEmailDto = {
            email: email || '',
            firstName: record['First name ▾']?.trim() || null,
            lastName: record['Last name ▾']?.trim() || null,
            phone: record['Phone ▾']?.trim() || null,
            country: record['Country ▾']?.trim() || null,
            city: record['City ▾']?.trim() || null,
            acquisitionSource: record['Acquisition ▾']?.trim() || null,
            acquisitionDate: this.parseDate(record['Acquisition date ▾']),
            funnelStage: record['Funnel ▾']?.trim() || null,
          };

          if (
            email &&
            await this.emailsService.storeTypoCandidate(
              emailData,
              ImportSourceType.JSON_IMPORT,
              `json_import_${path.basename(file)}`,
            )
          ) {
            invalidEmails++;
            continue;
          }

          // Skip invalid or phone-only contacts
          if (!email || email === '-' || !(await this.emailsService.isImportCandidateAccepted(email))) {
            invalidEmails++;
            continue;
          }

          // Deduplication check
          if (seenEmails.has(email)) {
            duplicateEmails++;
            continue;
          }

          seenEmails.add(email);

          // Add to batch
          batch.push(emailData);

          // Flush batch when full
          if (batch.length >= this.batchSize) {
            const result = await this.flushBatch(batch, path.basename(file));
            importedEmails += result.imported;
            duplicateEmails += result.duplicates;
            invalidEmails += result.errors;
            batch = []; // Reset batch
          }
        }

        processedFiles++;

        // Update progress every 1000 files
        if (processedFiles % 1000 === 0) {
          await this.importJobRepository.update(jobId, {
            processedFiles,
            totalRecords,
            processedRecords: totalRecords,
            importedEmails,
            duplicateEmails,
            invalidEmails,
          });

          this.logger.log(
            `Progress: ${processedFiles}/${totalFiles} files | ` +
            `Imported: ${importedEmails} | Duplicates: ${duplicateEmails}`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to process file ${file}: ${err.message}`);
        invalidEmails++;
      }
    }

    // Flush final batch
    if (batch.length > 0) {
      const result = await this.flushBatch(batch, 'final_batch');
      importedEmails += result.imported;
      duplicateEmails += result.duplicates;
      invalidEmails += result.errors;
    }

    // Mark job as completed
    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.COMPLETED,
      completedAt: new Date(),
      processedFiles,
      totalRecords,
      processedRecords: totalRecords,
      importedEmails,
      duplicateEmails,
      invalidEmails,
    });

    this.logger.log(
      `JSON import job ${jobId} completed | ` +
      `Files: ${processedFiles} | Records: ${totalRecords} | ` +
      `Imported: ${importedEmails} | Duplicates: ${duplicateEmails} | Invalid: ${invalidEmails}`,
    );
  }

  /**
   * Flush batch to database
   */
  private async flushBatch(
    batch: CreateEmailDto[],
    sourceIdentifier: string,
  ): Promise<{ imported: number; duplicates: number; errors: number }> {
    return this.emailsService.bulkCreate(
      batch,
      ImportSourceType.JSON_IMPORT,
      sourceIdentifier,
    );
  }

  /**
   * Get all JSON files sorted numerically
   */
  private async getJsonFiles(): Promise<string[]> {
    const files = await fs.readdir(this.jsonPagesPath);

    // Filter JSON files (page_*.json)
    const jsonFiles = files
      .filter((file) => file.startsWith('page_') && file.endsWith('.json'))
      .map((file) => path.join(this.jsonPagesPath, file));

    // Sort numerically (page_1.json, page_2.json, ... page_261281.json)
    jsonFiles.sort((a, b) => {
      const aNum = parseInt(path.basename(a).replace('page_', '').replace('.json', ''));
      const bNum = parseInt(path.basename(b).replace('page_', '').replace('.json', ''));
      return aNum - bNum;
    });

    return jsonFiles;
  }

  /**
   * Parse date from DD.MM.YYYY format
   */
  private parseDate(dateStr: string): Date | null {
    if (!dateStr) return null;

    try {
      const [day, month, year] = dateStr.split('.');
      return new Date(`${year}-${month}-${day}`);
    } catch {
      return null;
    }
  }

  /**
   * Mark job as failed
   */
  private async markJobFailed(jobId: number, errorMessage: string): Promise<void> {
    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.FAILED,
      completedAt: new Date(),
      errorMessage,
    });
  }

  /**
   * Get import job status
   */
  async getJobStatus(jobId: number): Promise<ImportJob> {
    return this.importJobRepository.findOne({ where: { id: jobId } });
  }

  /**
   * Get all import jobs
   */
  async getAllJobs(limit: number = 50): Promise<ImportJob[]> {
    return this.importJobRepository.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
