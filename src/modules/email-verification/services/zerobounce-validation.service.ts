import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import {
  EmailValidationBatchStatus,
  EmailValidationMappedStatus,
  EmailValidationSourceSegment,
  ExternalValidationProvider,
  SendEligibility,
} from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { EmailValidationBatch } from '../entities/email-validation-batch.entity';
import { EmailValidationEvent } from '../entities/email-validation-event.entity';
import {
  ExternalValidationImportResult,
  ExternalValidationImportService,
  ExternalValidationInputRow,
} from './external-validation-import.service';

export type ZeroBounceSegment =
  | 'smtp_failed_internal'
  | 'typo_resolved'
  | 'external_review';

export interface ZeroBounceCreditsResult {
  configured: boolean;
  credits: number | null;
  validKey: boolean | null;
}

export interface ZeroBouncePreviewResult {
  configured: boolean;
  validKey: boolean | null;
  segment: ZeroBounceSegment;
  limit: number;
  offset: number;
  search: string;
  total: number;
  rows: Array<{
    id: number;
    email: string;
    originalEmail: string;
    verificationStatus: VerificationStatus;
    sendEligibility: SendEligibility;
    doNotSendReason: string | null;
    lastValidationSource: ExternalValidationProvider | null;
    lastValidationAt: Date | null;
    source: string | null;
  }>;
  estimatedCredits: number;
  credits: number | null;
}

export interface ZeroBounceRunResult {
  dryRun: boolean;
  preview: ZeroBouncePreviewResult;
  submitted: number;
  creditsBefore: number | null;
  importResult: ExternalValidationImportResult | null;
}

export interface ZeroBounceExcludeResult {
  excluded: boolean;
  emailId: number;
  email: string;
  reasonCode: string;
}

@Injectable()
export class ZeroBounceValidationService {
  private readonly logger = new Logger(ZeroBounceValidationService.name);
  private readonly maxBatchSize = 100;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(EmailValidationBatch)
    private readonly batchRepository: Repository<EmailValidationBatch>,
    @InjectRepository(EmailValidationEvent)
    private readonly eventRepository: Repository<EmailValidationEvent>,
    private readonly externalValidationImportService: ExternalValidationImportService,
  ) {}

  async getCreditBalance(): Promise<ZeroBounceCreditsResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      return {
        configured: false,
        credits: null,
        validKey: null,
      };
    }

    const response = await this.callZeroBounce('getcredits', { api_key: apiKey });
    const credits = Number(response?.Credits);

    return {
      configured: true,
      credits: Number.isFinite(credits) ? credits : null,
      validKey: Number.isFinite(credits) ? credits >= 0 : false,
    };
  }

  async previewSegment(options: {
    segment?: ZeroBounceSegment;
    limit?: number;
    offset?: number;
    search?: string;
    emailIds?: number[];
    includeCredits?: boolean;
  }): Promise<ZeroBouncePreviewResult> {
    const segment = this.normalizeSegment(options.segment);
    const limit = this.normalizeLimit(options.limit);
    const offset = this.normalizeOffset(options.offset);
    const search = this.normalizeSearch(options.search);
    const emailIds = options.emailIds === undefined
      ? null
      : this.normalizeEmailIds(options.emailIds);
    const query = this.buildSegmentQuery(segment);

    if (search) {
      query.andWhere(
        `(
          email.email LIKE :queueSearch
          OR email.typoResolvedEmail LIKE :queueSearch
          OR email.typoSuggestion LIKE :queueSearch
          OR email.acquisitionSource LIKE :queueSearch
        )`,
        { queueSearch: `%${search}%` },
      );
    }

    if (emailIds !== null) {
      query.andWhere('email.id IN (:...selectedEmailIds)', {
        selectedEmailIds: emailIds.length ? emailIds : [-1],
      });
    }

    const total = await query.clone().getCount();
    const emails = await query
      .select([
        'email.id',
        'email.email',
        'email.typoSuggestion',
        'email.typoResolvedEmail',
        'email.verificationStatus',
        'email.sendEligibility',
        'email.doNotSendReason',
        'email.lastValidationSource',
        'email.lastValidationAt',
        'email.acquisitionSource',
      ])
      .skip(offset)
      .take(limit)
      .getMany();
    const creditBalance = options.includeCredits === false
      ? null
      : await this.getCreditBalance();

    return {
      configured: !!this.getApiKey(),
      validKey: creditBalance?.validKey ?? null,
      segment,
      limit,
      offset,
      search,
      total,
      rows: emails.map((email) => {
        const originalEmail = this.normalizeEmail(email.email);
        const validationEmail = segment === 'typo_resolved'
          ? this.normalizeEmail(email.typoResolvedEmail)
          : originalEmail;

        return {
          id: Number(email.id),
          email: validationEmail || originalEmail,
          originalEmail,
          verificationStatus: email.verificationStatus,
          sendEligibility: email.sendEligibility,
          doNotSendReason: email.doNotSendReason || null,
          lastValidationSource: email.lastValidationSource || null,
          lastValidationAt: email.lastValidationAt || null,
          source: email.acquisitionSource || null,
        };
      }),
      estimatedCredits: emails.length,
      credits: creditBalance?.credits ?? null,
    };
  }

  async validateSegment(options: {
    segment?: ZeroBounceSegment;
    emailIds?: number[];
    dryRun?: boolean;
  }): Promise<ZeroBounceRunResult> {
    const emailIds = this.normalizeEmailIds(options.emailIds || []);
    if (!emailIds.length) {
      throw new BadRequestException('Select at least one email before running ZeroBounce validation.');
    }

    const preview = await this.previewSegment({
      segment: options.segment,
      emailIds,
      limit: emailIds.length,
      offset: 0,
      includeCredits: true,
    });

    if (preview.rows.length !== emailIds.length) {
      throw new BadRequestException(
        'Some selected emails are no longer eligible. Reload the queue and select them again.',
      );
    }

    if (options.dryRun === true) {
      return {
        dryRun: true,
        preview,
        submitted: 0,
        creditsBefore: preview.credits,
        importResult: null,
      };
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new BadRequestException('ZEROBOUNCE_API_KEY is not configured');
    }

    if (!preview.rows.length) {
      return {
        dryRun: false,
        preview,
        submitted: 0,
        creditsBefore: preview.credits,
        importResult: null,
      };
    }

    if (preview.validKey === false) {
      throw new BadRequestException('ZEROBOUNCE_API_KEY is invalid');
    }

    if (preview.credits !== null && preview.credits >= 0 && preview.estimatedCredits > preview.credits) {
      throw new BadRequestException(
        `ZeroBounce has ${preview.credits} credits, but this batch needs ${preview.estimatedCredits}.`,
      );
    }

    const submittedRows = preview.rows.map((row) => ({
      id: row.id,
      email: row.email,
      source: row.source,
      verificationStatus: row.verificationStatus,
      sendEligibility: row.sendEligibility,
      doNotSendReason: row.doNotSendReason,
    }));
    const sourceSegment = this.mapSourceSegment(preview.segment);
    const batch = await this.createSubmittedBatch({
      segment: preview.segment,
      sourceSegment,
      submittedRows,
      creditsBefore: preview.credits,
      totalAvailable: preview.total,
    });
    const payload = {
      api_key: apiKey,
      email_batch: submittedRows.map((row) => ({
        email_address: row.email,
      })),
    };

    this.logger.log(
      `ZeroBounce batch ${batch.id} submitted: segment=${preview.segment}, rows=${submittedRows.length}, creditsBefore=${preview.credits ?? 'unknown'}`,
    );

    let response: any;
    try {
      response = await this.postZeroBounce('validatebatch', payload);
      await this.recordProviderResponse(batch.id, {
        segment: preview.segment,
        submittedRows,
        creditsBefore: preview.credits,
        totalAvailable: preview.total,
        response,
      });

      const providerRows = this.normalizeBatchResponse(response, preview.rows);
      const importResult = await this.externalValidationImportService.importRows({
        provider: ExternalValidationProvider.ZEROBOUNCE,
        rows: providerRows,
        dryRun: false,
        sourceSegment,
        batchName: `ZeroBounce API ${preview.segment}`,
        existingBatchId: batch.id,
        metadata: {
          source: 'zerobounce_api',
          segment: preview.segment,
          creditsBefore: preview.credits,
          submitted: preview.rows.length,
        },
      });

      this.logger.log(
        `ZeroBounce batch ${batch.id} completed: submitted=${submittedRows.length}, processed=${importResult.processed}, updated=${importResult.updated}`,
      );

      return {
        dryRun: false,
        preview,
        submitted: preview.rows.length,
        creditsBefore: preview.credits,
        importResult,
      };
    } catch (error) {
      await this.markSubmittedBatchFailed(batch.id, error, {
        segment: preview.segment,
        submittedRows,
        creditsBefore: preview.credits,
        totalAvailable: preview.total,
        response,
      });
      this.logger.error(
        `ZeroBounce batch ${batch.id} failed after submitting ${submittedRows.length} rows: ${this.errorMessage(error)}`,
      );
      throw error;
    }
  }

  async excludeFromExternalValidation(options: {
    emailId?: number;
    email?: string;
    note?: string;
  }): Promise<ZeroBounceExcludeResult> {
    const emailRecord = await this.findEmailForExclusion(options);
    const now = new Date();
    const reasonCode = 'external_validation_excluded';

    await this.eventRepository.save(
      this.eventRepository.create({
        batchId: null,
        emailId: Number(emailRecord.id),
        provider: ExternalValidationProvider.MANUAL,
        inputEmail: emailRecord.email,
        normalizedEmail: emailRecord.email,
        providerStatus: 'manual_excluded',
        providerSubStatus: 'zerobounce_queue',
        mappedStatus: EmailValidationMappedStatus.DO_NOT_MAIL,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode,
        confidenceScore: Number(emailRecord.qualityScore || 0),
        rawResponse: {
          source: 'zerobounce_preview',
          note: options.note || null,
          previous: {
            verificationStatus: emailRecord.verificationStatus,
            sendEligibility: emailRecord.sendEligibility,
            doNotSendReason: emailRecord.doNotSendReason,
            lastValidationSource: emailRecord.lastValidationSource,
          },
        },
        validatedAt: now,
      }),
    );

    await this.emailRepository.update(emailRecord.id, {
      sendEligibility: SendEligibility.DO_NOT_SEND,
      doNotSendReason: reasonCode,
      lastValidationSource: ExternalValidationProvider.MANUAL,
      lastValidationAt: now,
      lastVerifiedAt: now,
      smtpErrorMessage: 'Manually excluded from ZeroBounce validation queue',
    });

    return {
      excluded: true,
      emailId: Number(emailRecord.id),
      email: emailRecord.email,
      reasonCode,
    };
  }

  private buildSegmentQuery(segment: ZeroBounceSegment): SelectQueryBuilder<Email> {
    const query = this.emailRepository
      .createQueryBuilder('email')
      .where('email.email IS NOT NULL')
      .andWhere('email.email LIKE :emailPattern', { emailPattern: '%@%' })
      .andWhere('(email.lastValidationSource IS NULL OR email.lastValidationSource != :zerobounce)', {
        zerobounce: ExternalValidationProvider.ZEROBOUNCE,
      })
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM email_validation_events zeroBounceEvent
          WHERE zeroBounceEvent.emailId = email.id
            AND zeroBounceEvent.provider = :zerobounce
        )`,
      )
      .orderBy('email.updatedAt', 'DESC')
      .addOrderBy('email.id', 'DESC');

    if (segment === 'smtp_failed_internal') {
      return query
        .andWhere('email.verificationStatus = :invalidStatus', { invalidStatus: VerificationStatus.INVALID })
        .andWhere('email.doNotSendReason = :reason', { reason: 'invalid' })
        .andWhere('email.hasValidSyntax = :trueValue', { trueValue: true })
        .andWhere('email.hasValidDns = :trueValue', { trueValue: true })
        .andWhere('email.hasValidSmtp = :falseValue', { falseValue: false })
        .andWhere('(email.gmailCategory IS NULL OR email.gmailCategory NOT IN (:...protectedCategories))', {
          protectedCategories: ['unsubscribe', 'abuse'],
        });
    }

    if (segment === 'typo_resolved') {
      return query
        .andWhere('email.doNotSendReason = :reason', {
          reason: 'typo_accepted_external_validation_required',
        })
        .andWhere('email.sendEligibility = :review', { review: SendEligibility.REVIEW })
        .andWhere('email.typoResolvedEmail IS NOT NULL')
        .andWhere("TRIM(email.typoResolvedEmail) <> ''");
    }

    return query
      .andWhere('email.sendEligibility = :review', { review: SendEligibility.REVIEW })
      .andWhere('email.doNotSendReason LIKE :externalReason', {
        externalReason: 'external_validation_%',
      });
  }

  private normalizeBatchResponse(
    response: any,
    requestedRows: ZeroBouncePreviewResult['rows'],
  ): ExternalValidationInputRow[] {
    const byEmail = new Map(requestedRows.map((row) => [row.email.toLowerCase(), row]));
    const batchRows = Array.isArray(response?.email_batch) ? response.email_batch : [];

    return batchRows.map((row: any) => {
      const email = String(row?.address || row?.email_address || row?.email || '').trim().toLowerCase();
      const requested = byEmail.get(email);

      return {
        email,
        emailId: requested?.id || null,
        providerStatus: String(row?.status || 'unknown'),
        providerSubStatus: row?.sub_status ? String(row.sub_status) : null,
        raw: row,
      };
    }).filter((row: ExternalValidationInputRow) => !!row.email);
  }

  private async createSubmittedBatch(options: {
    segment: ZeroBounceSegment;
    sourceSegment: EmailValidationSourceSegment;
    submittedRows: Array<{
      id: number;
      email: string;
      source: string | null;
      verificationStatus: VerificationStatus;
      sendEligibility: SendEligibility;
      doNotSendReason: string | null;
    }>;
    creditsBefore: number | null;
    totalAvailable: number;
  }): Promise<EmailValidationBatch> {
    const submittedAt = new Date();

    return this.batchRepository.save(
      this.batchRepository.create({
        provider: ExternalValidationProvider.ZEROBOUNCE,
        status: EmailValidationBatchStatus.SUBMITTED,
        sourceSegment: options.sourceSegment,
        name: `ZeroBounce API ${options.segment}`,
        totalRecords: options.totalAvailable,
        submittedRecords: options.submittedRows.length,
        submittedAt,
        metadata: {
          source: 'zerobounce_api',
          segment: options.segment,
          creditsBefore: options.creditsBefore,
          submittedAt: submittedAt.toISOString(),
          submitted: options.submittedRows.length,
          submittedRows: options.submittedRows,
          request: {
            endpoint: 'validatebatch',
            emailBatch: options.submittedRows.map((row) => ({
              email_address: row.email,
              email_id: row.id,
            })),
          },
        },
      }),
    );
  }

  private async recordProviderResponse(batchId: number, options: {
    segment: ZeroBounceSegment;
    submittedRows: Array<{ id: number; email: string; source: string | null }>;
    creditsBefore: number | null;
    totalAvailable: number;
    response: any;
  }): Promise<void> {
    const responseRows = Array.isArray(options.response?.email_batch)
      ? options.response.email_batch
      : [];
    const errors = Array.isArray(options.response?.errors)
      ? options.response.errors
      : [];

    await this.batchRepository.update(batchId, {
      status: EmailValidationBatchStatus.RUNNING,
      metadata: {
        source: 'zerobounce_api',
        segment: options.segment,
        creditsBefore: options.creditsBefore,
        totalAvailable: options.totalAvailable,
        submitted: options.submittedRows.length,
        submittedRows: options.submittedRows,
        request: {
          endpoint: 'validatebatch',
          emailBatch: options.submittedRows.map((row) => ({
            email_address: row.email,
            email_id: row.id,
          })),
        },
        providerResponseReceivedAt: new Date().toISOString(),
        providerResponseSummary: this.summarizeZeroBounceResponse(responseRows, errors),
        providerResponse: options.response,
      } as any,
    });
  }

  private async markSubmittedBatchFailed(batchId: number, error: unknown, options: {
    segment: ZeroBounceSegment;
    submittedRows: Array<{ id: number; email: string; source: string | null }>;
    creditsBefore: number | null;
    totalAvailable: number;
    response?: any;
  }): Promise<void> {
    await this.batchRepository.update(batchId, {
      status: EmailValidationBatchStatus.FAILED,
      errorMessage: this.errorMessage(error),
      completedAt: new Date(),
      metadata: {
        source: 'zerobounce_api',
        segment: options.segment,
        creditsBefore: options.creditsBefore,
        totalAvailable: options.totalAvailable,
        submitted: options.submittedRows.length,
        submittedRows: options.submittedRows,
        request: {
          endpoint: 'validatebatch',
          emailBatch: options.submittedRows.map((row) => ({
            email_address: row.email,
            email_id: row.id,
          })),
        },
        failedAt: new Date().toISOString(),
        error: this.errorMessage(error),
        providerResponse: options.response || null,
      } as any,
    });
  }

  private summarizeZeroBounceResponse(rows: any[], errors: any[]): Record<string, any> {
    const byStatus = rows.reduce((acc, row) => {
      const status = String(row?.status || 'unknown').toLowerCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      rows: rows.length,
      errors: errors.length,
      byStatus,
    };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error || 'Unknown error');
  }

  private normalizeEmail(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  private mapSourceSegment(segment: ZeroBounceSegment): EmailValidationSourceSegment {
    if (segment === 'typo_resolved') {
      return EmailValidationSourceSegment.TYPO_RESOLVED;
    }

    if (segment === 'smtp_failed_internal') {
      return EmailValidationSourceSegment.SUPPLIKIT_INTAKE;
    }

    return EmailValidationSourceSegment.MANUAL;
  }

  private normalizeSegment(segment?: ZeroBounceSegment): ZeroBounceSegment {
    if (segment === 'typo_resolved' || segment === 'external_review') {
      return segment;
    }

    return 'smtp_failed_internal';
  }

  private async findEmailForExclusion(options: {
    emailId?: number;
    email?: string;
  }): Promise<Email> {
    const emailId = Number(options.emailId || 0) || null;
    const email = String(options.email || '').trim().toLowerCase();

    if (!emailId && !email) {
      throw new BadRequestException('emailId or email is required');
    }

    const emailRecord = emailId
      ? await this.emailRepository.findOne({ where: { id: emailId } })
      : await this.emailRepository.findOne({ where: { email } });

    if (!emailRecord) {
      throw new NotFoundException('Email row not found');
    }

    return emailRecord;
  }

  private normalizeLimit(limit?: number): number {
    const parsed = Number(limit || this.maxBatchSize);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return this.maxBatchSize;
    }

    return Math.min(Math.floor(parsed), this.maxBatchSize);
  }

  private normalizeOffset(offset?: number): number {
    const parsed = Number(offset || 0);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }

    return Math.floor(parsed);
  }

  private normalizeSearch(search?: string): string {
    return String(search || '').trim().slice(0, 200);
  }

  private normalizeEmailIds(emailIds: number[]): number[] {
    const normalized = Array.from(new Set(
      (Array.isArray(emailIds) ? emailIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ));

    if (normalized.length > this.maxBatchSize) {
      throw new BadRequestException(`A ZeroBounce batch can contain at most ${this.maxBatchSize} emails.`);
    }

    return normalized;
  }

  private getApiKey(): string | null {
    const value = this.configService.get<string>('ZEROBOUNCE_API_KEY');
    return value && value.trim() ? value.trim() : null;
  }

  private getBaseUrl(): string {
    return (this.configService.get<string>('ZEROBOUNCE_API_BASE_URL') || 'https://api-eu.zerobounce.net/v2')
      .replace(/\/+$/, '');
  }

  private async callZeroBounce(endpoint: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${this.getBaseUrl()}/${endpoint}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url.toString());

    return this.readZeroBounceResponse(endpoint, response);
  }

  private async postZeroBounce(endpoint: string, payload: Record<string, any>): Promise<any> {
    const response = await fetch(`${this.getBaseUrl()}/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return this.readZeroBounceResponse(endpoint, response);
  }

  private async readZeroBounceResponse(endpoint: string, response: Response): Promise<any> {
    const text = await response.text();
    let payload: any = {};

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      this.logger.warn(`ZeroBounce ${endpoint} returned non-JSON response`);
    }

    if (!response.ok) {
      throw new InternalServerErrorException(
        `ZeroBounce ${endpoint} failed with HTTP ${response.status}`,
      );
    }

    const errors = Array.isArray(payload?.errors)
      ? payload.errors
      : payload?.errors
        ? [payload.errors]
        : [];

    if (payload?.error || errors.length > 0) {
      throw new BadRequestException(payload.error || errors);
    }

    return payload;
  }
}
