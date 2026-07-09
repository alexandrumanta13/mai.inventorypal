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
  EmailValidationMappedStatus,
  EmailValidationSourceSegment,
  ExternalValidationProvider,
  SendEligibility,
} from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
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
  total: number;
  rows: Array<{
    id: number;
    email: string;
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
    includeCredits?: boolean;
  }): Promise<ZeroBouncePreviewResult> {
    const segment = this.normalizeSegment(options.segment);
    const limit = this.normalizeLimit(options.limit);
    const query = this.buildSegmentQuery(segment);
    const total = await query.clone().getCount();
    const emails = await query
      .select([
        'email.id',
        'email.email',
        'email.verificationStatus',
        'email.sendEligibility',
        'email.doNotSendReason',
        'email.lastValidationSource',
        'email.lastValidationAt',
        'email.acquisitionSource',
      ])
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
      total,
      rows: emails.map((email) => ({
        id: Number(email.id),
        email: email.email,
        verificationStatus: email.verificationStatus,
        sendEligibility: email.sendEligibility,
        doNotSendReason: email.doNotSendReason || null,
        lastValidationSource: email.lastValidationSource || null,
        lastValidationAt: email.lastValidationAt || null,
        source: email.acquisitionSource || null,
      })),
      estimatedCredits: emails.length,
      credits: creditBalance?.credits ?? null,
    };
  }

  async validateSegment(options: {
    segment?: ZeroBounceSegment;
    limit?: number;
    dryRun?: boolean;
  }): Promise<ZeroBounceRunResult> {
    const preview = await this.previewSegment({
      segment: options.segment,
      limit: options.limit,
      includeCredits: true,
    });

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

    const payload = {
      api_key: apiKey,
      email_batch: preview.rows.map((row) => ({
        email_address: row.email,
      })),
    };

    const response = await this.postZeroBounce('validatebatch', payload);
    const providerRows = this.normalizeBatchResponse(response, preview.rows);
    const importResult = await this.externalValidationImportService.importRows({
      provider: ExternalValidationProvider.ZEROBOUNCE,
      rows: providerRows,
      dryRun: false,
      sourceSegment: this.mapSourceSegment(preview.segment),
      batchName: `ZeroBounce API ${preview.segment}`,
      metadata: {
        source: 'zerobounce_api',
        segment: preview.segment,
        creditsBefore: preview.credits,
        submitted: preview.rows.length,
      },
    });

    return {
      dryRun: false,
      preview,
      submitted: preview.rows.length,
      creditsBefore: preview.credits,
      importResult,
    };
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
        .andWhere('email.sendEligibility = :review', { review: SendEligibility.REVIEW });
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

    if (payload?.error || payload?.errors) {
      throw new BadRequestException(payload.error || payload.errors);
    }

    return payload;
  }
}
