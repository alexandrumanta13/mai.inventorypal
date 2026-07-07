import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { ImportJob } from '../entities/import-job.entity';
import {
  ImportJobSourceType,
  ImportJobStatus,
  ImportSourceType,
} from '@shared/enums/import-source.enum';
import { EmailsService, CreateEmailDto } from '@modules/emails/services/emails.service';
import { DomainsService } from '@modules/domains/services/domains.service';
import { CustomersService } from '@modules/customers/services/customers.service';
import { Email } from '@modules/emails/entities/email.entity';

interface CsvRecord {
  billing_email: string;
  billing_first_name?: string;
  billing_last_name?: string;
  billing_phone?: string;
  billing_city?: string;
  billing_state?: string;
  billing_country?: string;
}

@Injectable()
export class CsvImportService {
  private readonly logger = new Logger(CsvImportService.name);
  private readonly csvOrdersPath: string;
  private readonly batchSize: number;

  constructor(
    @InjectRepository(ImportJob)
    private readonly importJobRepository: Repository<ImportJob>,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    private readonly emailsService: EmailsService,
    private readonly domainsService: DomainsService,
    private readonly customersService: CustomersService,
    private readonly configService: ConfigService,
  ) {
    this.csvOrdersPath = this.configService.get<string>(
      'CSV_ORDERS_PATH',
      '/Users/alexmanta/Developer/sem/sites-orders',
    );
    this.batchSize = this.configService.get<number>('IMPORT_BATCH_SIZE', 10000);
  }

  /**
   * Start CSV import job (fires async process)
   */
  async startCsvImport(): Promise<ImportJob> {
    // Create import job
    const job = await this.importJobRepository.save({
      sourceType: ImportJobSourceType.CSV,
      status: ImportJobStatus.PENDING,
    });

    // Fire and forget
    this.processCsvImport(job.id).catch((err) => {
      this.logger.error(`CSV import job ${job.id} failed: ${err.message}`, err.stack);
      this.markJobFailed(job.id, err.message);
    });

    return job;
  }

  /**
   * Process CSV import (async background)
   */
  private async processCsvImport(jobId: number): Promise<void> {
    this.logger.log(`Starting CSV import job ${jobId}`);

    // Mark job as running
    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.RUNNING,
      startedAt: new Date(),
    });

    // Get all CSV files
    const files = await this.getCsvFiles();
    const totalFiles = files.length;

    this.logger.log(`Found ${totalFiles} CSV files to process`);

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
    let customersCreated = 0;
    let customersUpdated = 0;

    // Process files sequentially
    for (const file of files) {
      try {
        // Determine domain ID from filename
        const domainId = this.getDomainIdFromFilename(file);

        if (domainId) {
          this.logger.log(`Processing ${path.basename(file)} for domain ID ${domainId}`);
        } else {
          this.logger.log(`Processing ${path.basename(file)} (no domain mapping)`);
        }
        // Read and parse CSV file
        const content = await fs.readFile(file, 'utf-8');

        // Remove BOM if present (Excel exports often have BOM)
        const cleanContent = content.replace(/^\uFEFF/, '');

        const records = parse(cleanContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          bom: true,
        }) as CsvRecord[];

        totalRecords += records.length;

        // Process each record in the file
        for (const record of records) {
          const email = record.billing_email?.trim().toLowerCase();
          const emailData: CreateEmailDto = {
            email: email || '',
            firstName: record.billing_first_name?.trim() || null,
            lastName: record.billing_last_name?.trim() || null,
            phone: record.billing_phone?.trim() || null,
            country: record.billing_country?.trim() || null,
            city: record.billing_city?.trim() || null,
            acquisitionSource: `csv_import_${path.basename(file, '.csv')}`,
            acquisitionDate: new Date(), // Current date for CSV imports
            funnelStage: null,
          };

          if (
            email &&
            await this.emailsService.storeTypoCandidate(
              emailData,
              ImportSourceType.CSV_IMPORT,
              `csv_import_${path.basename(file)}`,
            )
          ) {
            invalidEmails++;
            continue;
          }

          // Skip invalid emails
          if (!email || email === '-' || !(await this.emailsService.isImportCandidateAccepted(email))) {
            invalidEmails++;
            continue;
          }

          // Deduplication check (in-memory)
          if (seenEmails.has(email)) {
            duplicateEmails++;
            continue;
          }

          seenEmails.add(email);

          // Map CSV fields to CreateEmailDto
          batch.push(emailData);

          // Flush batch when full
          if (batch.length >= this.batchSize) {
            const result = await this.flushBatch(batch, path.basename(file));
            importedEmails += result.imported;
            duplicateEmails += result.duplicates;
            invalidEmails += result.errors;

            // Process customers for this batch if domain is mapped
            if (domainId) {
              const customerResult = await this.processCustomersForBatch(batch, domainId);
              customersCreated += customerResult.created;
              customersUpdated += customerResult.updated;
            }

            batch = []; // Reset batch
          }
        }

        // Flush remaining batch for this file
        if (batch.length > 0) {
          const result = await this.flushBatch(batch, path.basename(file));
          importedEmails += result.imported;
          duplicateEmails += result.duplicates;
          invalidEmails += result.errors;

          // Process customers for final batch if domain is mapped
          if (domainId) {
            const customerResult = await this.processCustomersForBatch(batch, domainId);
            customersCreated += customerResult.created;
            customersUpdated += customerResult.updated;
          }

          batch = []; // Reset batch
        }

        processedFiles++;

        // Update progress after each file
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
          `${path.basename(file)} | ` +
          `Emails: ${importedEmails} imported, ${duplicateEmails} duplicates | ` +
          `Customers: ${customersCreated} created, ${customersUpdated} updated`,
        );
      } catch (err) {
        this.logger.error(`Failed to process file ${file}: ${err.message}`);
        invalidEmails++;
      }
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
      `CSV import job ${jobId} completed | ` +
      `Files: ${processedFiles} | Records: ${totalRecords} | ` +
      `Emails: ${importedEmails} imported, ${duplicateEmails} duplicates, ${invalidEmails} invalid | ` +
      `Customers: ${customersCreated} created, ${customersUpdated} updated`,
    );
  }

  /**
   * Flush batch to database
   * Note: DB-level duplicates are handled by UNIQUE constraint on email column
   */
  private async flushBatch(
    batch: CreateEmailDto[],
    sourceIdentifier: string,
  ): Promise<{ imported: number; duplicates: number; errors: number }> {
    return this.emailsService.bulkCreate(
      batch,
      ImportSourceType.CSV_IMPORT,
      sourceIdentifier,
    );
  }

  /**
   * Get all CSV files from orders folder
   */
  private async getCsvFiles(): Promise<string[]> {
    const files = await fs.readdir(this.csvOrdersPath);

    // Filter CSV files
    const csvFiles = files
      .filter((file) => file.endsWith('.csv'))
      .map((file) => path.join(this.csvOrdersPath, file));

    // Sort alphabetically
    csvFiles.sort();

    return csvFiles;
  }

  /**
   * Map CSV filename to domain ID
   * Returns null if file doesn't match any known domain
   */
  private getDomainIdFromFilename(filename: string): number | null {
    const basename = path.basename(filename, '.csv').toLowerCase();

    // Map filenames to domain IDs
    if (basename.includes('lenjeriiieftine')) {
      return 6; // lenjeriiieftine.ro
    } else if (basename.includes('depozitul') || basename.includes('asternuturi-comenzi')) {
      return 5; // depozituldeasternuturi.ro
    } else if (basename.includes('fabrica-pucioasa') || basename === 'fabrica') {
      return 4; // fabricapucioasa.ro
    }

    return null; // Unknown domain
  }

  /**
   * Process customers for a batch of emails
   */
  private async processCustomersForBatch(
    batch: CreateEmailDto[],
    domainId: number,
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;

    for (const emailDto of batch) {
      try {
        const normalizedEmail = emailDto.email.toLowerCase().trim();

        // Check if customer already exists
        const existingCustomer = await this.customersService.findByEmail(normalizedEmail);

        if (existingCustomer) {
          updated++;
        } else {
          created++;
        }

        // Upsert customer with CSV data
        const customer = await this.customersService.upsert({
          email: normalizedEmail,
          firstName: emailDto.firstName || '',
          lastName: emailDto.lastName || '',
          phone: emailDto.phone,
          city: emailDto.city,
          country: emailDto.country,
          primaryDomainId: existingCustomer ? existingCustomer.primary_domain_id : domainId,
        });

        // Associate customer with domain (will not duplicate if already exists)
        await this.customersService.associateWithDomain(customer.id, domainId, {});

        // Link email records to customer
        await this.emailRepository.update(
          { email: normalizedEmail },
          { customerId: customer.id },
        );
      } catch (error) {
        this.logger.error(`Error processing customer for ${emailDto.email}: ${error.message}`);
      }
    }

    return { created, updated };
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
      where: { sourceType: ImportJobSourceType.CSV },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
