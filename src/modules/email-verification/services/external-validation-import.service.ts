import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { parse } from 'csv-parse/sync';
import { Repository } from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import {
  EmailValidationBatchStatus,
  EmailValidationMappedStatus,
  EmailValidationSourceSegment,
  ExternalValidationProvider,
  SendEligibility,
} from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import {
  extractEmailDomain,
  isPublicMailboxDomain,
} from '@shared/email-domain-classification';
import { EmailValidationBatch } from '../entities/email-validation-batch.entity';
import { EmailValidationEvent } from '../entities/email-validation-event.entity';

export interface ExternalValidationImportOptions {
  provider?: ExternalValidationProvider;
  csv: string;
  dryRun?: boolean;
  sourceSegment?: EmailValidationSourceSegment;
  batchName?: string;
}

export interface ExternalValidationRowsImportOptions {
  provider?: ExternalValidationProvider;
  rows: ExternalValidationInputRow[];
  dryRun?: boolean;
  sourceSegment?: EmailValidationSourceSegment;
  batchName?: string;
  metadata?: Record<string, any>;
  existingBatchId?: number | null;
}

export interface ExternalValidationImportResult {
  dryRun: boolean;
  provider: ExternalValidationProvider;
  received: number;
  processed: number;
  matched: number;
  missing: number;
  updated: number;
  byMappedStatus: Record<string, number>;
  rows: Array<{
    email: string;
    emailId: number | null;
    providerStatus: string;
    providerSubStatus: string | null;
    mappedStatus: EmailValidationMappedStatus;
    action: string;
    sendEligibility: SendEligibility;
    reasonCode: string | null;
  }>;
}

export interface ExternalValidationInputRow {
  email: string;
  emailId?: number | null;
  providerStatus: string;
  providerSubStatus?: string | null;
  raw?: Record<string, any>;
}

interface NormalizedExternalValidationRow {
  email: string;
  emailId: number | null;
  providerStatus: string;
  providerSubStatus: string | null;
  raw: Record<string, any>;
}

const TEMPORARY_EXTERNAL_SUB_STATUSES = new Set([
  'antispam_system',
  'exception_occurred',
  'failed_smtp_connection',
  'forcible_disconnect',
  'greylisted',
  'mail_server_did_not_respond',
  'mail_server_temporary_error',
  'mailbox_quota_exceeded',
  'timeout_exceeded',
]);

@Injectable()
export class ExternalValidationImportService {
  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(EmailValidationBatch)
    private readonly batchRepository: Repository<EmailValidationBatch>,
    @InjectRepository(EmailValidationEvent)
    private readonly eventRepository: Repository<EmailValidationEvent>,
  ) {}

  async importCsv(options: ExternalValidationImportOptions): Promise<ExternalValidationImportResult> {
    return this.importRows({
      provider: options.provider,
      rows: this.normalizeCsvRows(options.csv),
      dryRun: options.dryRun,
      sourceSegment: options.sourceSegment,
      batchName: options.batchName,
      metadata: {
        source: 'external_validation_csv',
      },
    });
  }

  async importRows(options: ExternalValidationRowsImportOptions): Promise<ExternalValidationImportResult> {
    const provider = this.normalizeProvider(options.provider);
    const dryRun = options.dryRun === true;
    const rows = options.rows
      .map((row) => this.normalizeInputRow(row))
      .filter((row): row is NormalizedExternalValidationRow => !!row);
    const result: ExternalValidationImportResult = {
      dryRun,
      provider,
      received: rows.length,
      processed: 0,
      matched: 0,
      missing: 0,
      updated: 0,
      byMappedStatus: {},
      rows: [],
    };
    const batch = dryRun
      ? null
      : await this.resolveBatchForImport({
          existingBatchId: options.existingBatchId,
          provider,
          sourceSegment: options.sourceSegment,
          batchName: options.batchName,
          rowsCount: rows.length,
          metadata: options.metadata,
        });

    for (const row of rows) {
      await this.processRow(row, provider, result, dryRun, batch?.id || null);
    }

    if (batch && !dryRun) {
      await this.batchRepository.update(batch.id, {
        status: EmailValidationBatchStatus.COMPLETED,
        processedRecords: result.processed,
        validCount: result.byMappedStatus[EmailValidationMappedStatus.VALID] || 0,
        invalidCount: result.byMappedStatus[EmailValidationMappedStatus.INVALID] || 0,
        riskyCount: result.byMappedStatus[EmailValidationMappedStatus.RISKY] || 0,
        unknownCount: result.byMappedStatus[EmailValidationMappedStatus.UNKNOWN] || 0,
        catchAllCount: result.byMappedStatus[EmailValidationMappedStatus.CATCH_ALL] || 0,
        disposableCount: result.byMappedStatus[EmailValidationMappedStatus.DISPOSABLE] || 0,
        completedAt: new Date(),
      });
    }

    return result;
  }

  private async resolveBatchForImport(options: {
    existingBatchId?: number | null;
    provider: ExternalValidationProvider;
    sourceSegment?: EmailValidationSourceSegment;
    batchName?: string;
    rowsCount: number;
    metadata?: Record<string, any>;
  }): Promise<EmailValidationBatch> {
    if (options.existingBatchId) {
      const existingBatch = await this.batchRepository.findOne({
        where: { id: options.existingBatchId },
      });

      if (existingBatch) {
        return existingBatch;
      }
    }

    return this.batchRepository.save(
      this.batchRepository.create({
        provider: options.provider,
        status: EmailValidationBatchStatus.COMPLETED,
        sourceSegment: options.sourceSegment || EmailValidationSourceSegment.UNKNOWN,
        name: options.batchName || `${options.provider} CSV result import`,
        totalRecords: options.rowsCount,
        submittedRecords: options.rowsCount,
        submittedAt: new Date(),
        completedAt: new Date(),
        metadata: {
          ...(options.metadata || {}),
        },
      }),
    );
  }

  private normalizeInputRow(row: ExternalValidationInputRow): NormalizedExternalValidationRow | null {
    const email = this.normalizeEmail(row.email);
    if (!email) {
      return null;
    }

    return {
      email,
      emailId: Number(row.emailId || 0) || null,
      providerStatus: String(row.providerStatus || 'unknown').trim() || 'unknown',
      providerSubStatus: row.providerSubStatus ? String(row.providerSubStatus).trim() : null,
      raw: row.raw || {},
    };
  }

  private async processRow(
    row: NormalizedExternalValidationRow,
    provider: ExternalValidationProvider,
    result: ExternalValidationImportResult,
    dryRun: boolean,
    batchId: number | null,
  ) {
    const mappedStatus = this.applyProviderPolicy(
      row,
      this.mapProviderStatus(row.providerStatus, row.providerSubStatus),
    );
    result.byMappedStatus[mappedStatus] = (result.byMappedStatus[mappedStatus] || 0) + 1;
    result.processed++;

    const emailRecord = row.emailId
      ? await this.emailRepository.findOne({ where: { id: row.emailId } })
      : await this.emailRepository.findOne({ where: { email: row.email } });

    if (!emailRecord) {
      result.missing++;
      result.rows.push({
        email: row.email,
        emailId: row.emailId,
        providerStatus: row.providerStatus,
        providerSubStatus: row.providerSubStatus,
        mappedStatus,
        action: 'missing_email_row',
        sendEligibility: SendEligibility.PENDING,
        reasonCode: 'missing_email_row',
      });
      return;
    }

    result.matched++;
    const decision = this.buildDecision(
      emailRecord,
      mappedStatus,
      row.email,
      row.providerSubStatus,
    );

    if (!dryRun) {
      await this.eventRepository.save(
        this.eventRepository.create({
          batchId,
          emailId: emailRecord.id,
          provider,
          inputEmail: row.email,
          normalizedEmail: row.email,
          providerStatus: row.providerStatus,
          providerSubStatus: row.providerSubStatus,
          mappedStatus,
          sendEligibility: decision.sendEligibility,
          reasonCode: decision.reasonCode,
          confidenceScore: decision.qualityScore,
          rawResponse: row.raw,
          validatedAt: new Date(),
        }),
      );

      await this.emailRepository.update(emailRecord.id, {
        verificationStatus: decision.verificationStatus,
        qualityScore: decision.qualityScore,
        hasValidSyntax: decision.hasValidSyntax,
        hasValidDns: decision.hasValidDns,
        hasValidSmtp: decision.hasValidSmtp,
        isDisposable: decision.isDisposable,
        hasTypo: decision.hasTypo,
        typoResolutionNote: decision.typoResolutionNote,
        sendEligibility: decision.sendEligibility,
        doNotSendReason: decision.reasonCode,
        lastValidationSource: provider,
        lastValidationAt: new Date(),
        lastVerifiedAt: new Date(),
        smtpErrorMessage: decision.smtpErrorMessage,
      });
      result.updated++;
    }

    result.rows.push({
      email: row.email,
      emailId: Number(emailRecord.id),
      providerStatus: row.providerStatus,
      providerSubStatus: row.providerSubStatus,
      mappedStatus,
      action: dryRun ? 'would_update_email' : 'updated_email',
      sendEligibility: decision.sendEligibility,
      reasonCode: decision.reasonCode,
    });
  }

  private buildDecision(
    emailRecord: Email,
    mappedStatus: EmailValidationMappedStatus,
    inputEmail: string,
    providerSubStatus: string | null,
  ): {
    verificationStatus: VerificationStatus;
    qualityScore: number;
    hasValidSyntax: boolean;
    hasValidDns: boolean;
    hasValidSmtp: boolean;
    isDisposable: boolean;
    hasTypo: boolean;
    sendEligibility: SendEligibility;
    reasonCode: string | null;
    typoResolutionNote: string | null;
    smtpErrorMessage: string;
  } {
    const protectedReason = this.getProtectedReason(emailRecord);
    const providerRequiresBlocking = [
      EmailValidationMappedStatus.INVALID,
      EmailValidationMappedStatus.DISPOSABLE,
      EmailValidationMappedStatus.DO_NOT_MAIL,
      EmailValidationMappedStatus.SPAMTRAP,
      EmailValidationMappedStatus.ABUSE,
    ].includes(mappedStatus);

    if (protectedReason && !providerRequiresBlocking) {
      return {
        verificationStatus: emailRecord.verificationStatus,
        qualityScore: Number(emailRecord.qualityScore || 0),
        hasValidSyntax: emailRecord.hasValidSyntax,
        hasValidDns: emailRecord.hasValidDns,
        hasValidSmtp: emailRecord.hasValidSmtp,
        isDisposable: emailRecord.isDisposable,
        hasTypo: emailRecord.hasTypo,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: protectedReason,
        typoResolutionNote: emailRecord.typoResolutionNote || null,
        smtpErrorMessage: `External validation did not override protected suppression: ${protectedReason}`,
      };
    }

    if (mappedStatus === EmailValidationMappedStatus.VALID) {
      return {
        verificationStatus: VerificationStatus.VALID,
        qualityScore: 95,
        hasValidSyntax: true,
        hasValidDns: true,
        hasValidSmtp: true,
        isDisposable: false,
        hasTypo: false,
        sendEligibility: SendEligibility.SAFE_TO_SEND,
        reasonCode: null,
        typoResolutionNote: emailRecord.hasTypo
          ? 'External validation accepted recovered typo email'
          : emailRecord.typoResolutionNote || null,
        smtpErrorMessage: 'External validation accepted email for sending',
      };
    }

    if (mappedStatus === EmailValidationMappedStatus.DISPOSABLE) {
      return {
        verificationStatus: VerificationStatus.DISPOSABLE,
        qualityScore: 0,
        hasValidSyntax: true,
        hasValidDns: emailRecord.hasValidDns,
        hasValidSmtp: false,
        isDisposable: true,
        hasTypo: emailRecord.hasTypo,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: 'external_validation_disposable',
        typoResolutionNote: emailRecord.typoResolutionNote || null,
        smtpErrorMessage: 'External validation marked email as disposable',
      };
    }

    if (mappedStatus === EmailValidationMappedStatus.RISKY) {
      const reasonCode = this.getPolicyReviewReason(inputEmail, providerSubStatus)
        || 'external_validation_risky';
      const suspectDisposable = reasonCode === 'external_validation_suspect_public_disposable';

      return {
        verificationStatus: VerificationStatus.RISKY,
        qualityScore: 40,
        hasValidSyntax: true,
        hasValidDns: emailRecord.hasValidDns,
        hasValidSmtp: false,
        isDisposable: suspectDisposable ? false : emailRecord.isDisposable,
        hasTypo: emailRecord.hasTypo,
        sendEligibility: SendEligibility.REVIEW,
        reasonCode,
        typoResolutionNote: emailRecord.typoResolutionNote || null,
        smtpErrorMessage: `External validation requires policy review: ${providerSubStatus || 'risky'}`,
      };
    }

    if ([
      EmailValidationMappedStatus.INVALID,
      EmailValidationMappedStatus.DO_NOT_MAIL,
      EmailValidationMappedStatus.SPAMTRAP,
      EmailValidationMappedStatus.ABUSE,
    ].includes(mappedStatus)) {
      return {
        verificationStatus: VerificationStatus.INVALID,
        qualityScore: 0,
        hasValidSyntax: true,
        hasValidDns: emailRecord.hasValidDns,
        hasValidSmtp: false,
        isDisposable: emailRecord.isDisposable,
        hasTypo: emailRecord.hasTypo,
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: `external_validation_${mappedStatus}`,
        typoResolutionNote: emailRecord.typoResolutionNote || null,
        smtpErrorMessage: `External validation blocked email: ${mappedStatus}`,
      };
    }

    return {
      verificationStatus: VerificationStatus.UNKNOWN,
      qualityScore: 55,
      hasValidSyntax: true,
      hasValidDns: emailRecord.hasValidDns,
      hasValidSmtp: false,
      isDisposable: emailRecord.isDisposable,
      hasTypo: emailRecord.hasTypo,
      sendEligibility: SendEligibility.REVIEW,
      reasonCode: mappedStatus === EmailValidationMappedStatus.CATCH_ALL
        ? 'external_validation_catch_all'
        : 'external_validation_unknown',
      typoResolutionNote: emailRecord.typoResolutionNote || null,
      smtpErrorMessage: `External validation requires review: ${mappedStatus}`,
    };
  }

  private getProtectedReason(emailRecord: Email): string | null {
    if (emailRecord.gmailCategory === 'unsubscribe' || emailRecord.verificationStatus === VerificationStatus.UNSUBSCRIBED) {
      return 'unsubscribed';
    }

    if (emailRecord.gmailCategory === 'abuse' || emailRecord.doNotSendReason === 'abuse_detected') {
      return 'abuse_detected';
    }

    if (emailRecord.doNotSendReason === 'bounce_after_unsubscribe') {
      return 'bounce_after_unsubscribe';
    }

    if (emailRecord.doNotSendReason === 'bounce_recovery_ignored' || emailRecord.doNotSendReason === 'typo_ignored') {
      return emailRecord.doNotSendReason;
    }

    return null;
  }

  private normalizeCsvRows(csv: string): NormalizedExternalValidationRow[] {
    const records = parse(String(csv || ''), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    }) as Record<string, any>[];

    return records
      .map((record) => this.normalizeRecord(record))
      .filter((row): row is NormalizedExternalValidationRow => !!row);
  }

  private normalizeRecord(record: Record<string, any>): NormalizedExternalValidationRow | null {
    const normalizedKeys = Object.keys(record).reduce((acc, key) => {
      acc[this.normalizeColumnName(key)] = record[key];
      return acc;
    }, {} as Record<string, any>);
    const email = this.normalizeEmail(
      this.firstValue(normalizedKeys, ['email', 'address', 'emailaddress', 'emailtoverify', 'inputemail']),
    );
    if (!email) {
      return null;
    }

    const providerStatus = String(
      this.firstValue(normalizedKeys, ['status', 'result', 'validationstatus', 'verificationstatus', 'deliverability']) || 'unknown',
    ).trim();
    const providerSubStatus = this.firstValue(normalizedKeys, ['substatus', 'sub_status', 'subresult', 'reason']);
    const emailId = Number(this.firstValue(normalizedKeys, ['emailid', 'email_id']) || 0) || null;

    return {
      email,
      emailId,
      providerStatus,
      providerSubStatus: providerSubStatus ? String(providerSubStatus).trim() : null,
      raw: record,
    };
  }

  private mapProviderStatus(status: string, subStatus?: string | null): EmailValidationMappedStatus {
    const normalized = `${status || ''} ${subStatus || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (['valid', 'deliverable', 'ok'].includes(normalized) || normalized.startsWith('valid_')) {
      return EmailValidationMappedStatus.VALID;
    }

    if (normalized.includes('spamtrap')) {
      return EmailValidationMappedStatus.SPAMTRAP;
    }

    if (normalized.includes('abuse') || normalized.includes('complaint')) {
      return EmailValidationMappedStatus.ABUSE;
    }

    if (normalized.includes('do_not_mail') || normalized.includes('do_not_send')) {
      return EmailValidationMappedStatus.DO_NOT_MAIL;
    }

    if (normalized.includes('disposable')) {
      return EmailValidationMappedStatus.DISPOSABLE;
    }

    if (normalized.includes('catch_all') || normalized.includes('catchall') || normalized.includes('accept_all')) {
      return EmailValidationMappedStatus.CATCH_ALL;
    }

    if (normalized.includes('unknown') || normalized.includes('unverifiable')) {
      return EmailValidationMappedStatus.UNKNOWN;
    }

    if (normalized.includes('invalid') || normalized.includes('bounce')) {
      return EmailValidationMappedStatus.INVALID;
    }

    return EmailValidationMappedStatus.UNKNOWN;
  }

  private applyProviderPolicy(
    row: NormalizedExternalValidationRow,
    mappedStatus: EmailValidationMappedStatus,
  ): EmailValidationMappedStatus {
    const subStatus = this.normalizeProviderCode(row.providerSubStatus);

    if (TEMPORARY_EXTERNAL_SUB_STATUSES.has(subStatus)) {
      return EmailValidationMappedStatus.RISKY;
    }

    if (
      subStatus === 'disposable'
      && isPublicMailboxDomain(extractEmailDomain(row.email), { includeObserve: true })
    ) {
      return EmailValidationMappedStatus.RISKY;
    }

    return mappedStatus;
  }

  private getPolicyReviewReason(email: string, providerSubStatus: string | null): string | null {
    const subStatus = this.normalizeProviderCode(providerSubStatus);

    if (TEMPORARY_EXTERNAL_SUB_STATUSES.has(subStatus)) {
      return `external_validation_temporary_${subStatus}`;
    }

    if (
      subStatus === 'disposable'
      && isPublicMailboxDomain(extractEmailDomain(email), { includeObserve: true })
    ) {
      return 'external_validation_suspect_public_disposable';
    }

    return null;
  }

  private normalizeProviderCode(value: string | null | undefined): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private normalizeProvider(provider?: ExternalValidationProvider): ExternalValidationProvider {
    if (provider === ExternalValidationProvider.ZEROBOUNCE || provider === ExternalValidationProvider.NEVERBOUNCE) {
      return provider;
    }

    return ExternalValidationProvider.ZEROBOUNCE;
  }

  private firstValue(record: Record<string, any>, keys: string[]): any {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== '') {
        return record[key];
      }
    }

    return null;
  }

  private normalizeColumnName(value: string): string {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  private normalizeEmail(email: string | null | undefined): string | null {
    const normalized = String(email || '').trim().toLowerCase();
    return normalized.includes('@') ? normalized : null;
  }
}
