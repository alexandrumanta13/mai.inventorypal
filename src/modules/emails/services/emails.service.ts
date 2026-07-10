import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from '../entities/email.entity';
import { EmailSource } from '../entities/email-source.entity';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ImportSourceType } from '@shared/enums/import-source.enum';
import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { FilterValidator } from '../../email-verification/validators/filter.validator';
import { SendEligibilityService } from './send-eligibility.service';
import {
  BounceRecoveryCandidate,
  BounceRecoveryReason,
  BounceRecoveryStatus,
} from '../../email-verification/entities/bounce-recovery-candidate.entity';

export interface CreateEmailDto {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  country?: string;
  city?: string;
  acquisitionSource?: string;
  acquisitionDate?: Date;
  funnelStage?: string;
}

export interface BulkCreateResult {
  imported: number;
  duplicates: number;
  errors: number;
}

export interface StoreTypoCandidateOptions {
  suggestedEmail?: string;
  reason?: string;
  smtpErrorMessage?: string;
}

export type NeverBounceExportSegment =
  | 'typo_resolved'
  | 'typo_suggestions'
  | 'domain'
  | 'recovery_all'
  | 'recovery_domain_typo'
  | 'recovery_name_typo'
  | 'recovery_manual_edit';
export type TypoResolutionStatus = 'pending' | 'accepted' | 'ignored';
export type TypoResolutionAction = 'accept' | 'ignore' | 'reset';

export interface NeverBounceExportOptions {
  segment: NeverBounceExportSegment;
  domain?: string;
  batch?: number;
  limit?: number;
}

export interface NeverBounceExportRow {
  email: string;
  originalEmail: string;
  emailId: number;
  customerId: number | null;
  originalDomain: string;
  exportDomain: string;
  segment: NeverBounceExportSegment;
  verificationStatus: VerificationStatus;
  qualityScore: number;
  acquisitionSource: string;
  firstName: string;
  lastName: string;
  recoveryReason?: string;
  recoveryConfidence?: string;
  recoverySource?: string;
  sendEligibility?: SendEligibility;
  doNotSendReason?: string;
}

export interface NeverBounceExportPreview {
  segment: NeverBounceExportSegment;
  domain?: string;
  batch: number;
  limit: number;
  offset: number;
  total: number;
  totalBatches: number;
  rows: NeverBounceExportRow[];
}

export type CampaignExportEligibility =
  | SendEligibility.SAFE_TO_SEND
  | SendEligibility.REVIEW
  | SendEligibility.PENDING;

export interface CampaignExportOptions {
  eligibility?: CampaignExportEligibility;
  domain?: string;
  batch?: number;
  limit?: number;
}

export interface CampaignExportRow {
  email: string;
  emailId: number;
  customerId: number | null;
  firstName: string;
  lastName: string;
  emailDomain: string;
  sendEligibility: SendEligibility;
  doNotSendReason: string;
  verificationStatus: VerificationStatus;
  qualityScore: number;
  acquisitionSource: string;
  lastValidationSource: string;
  lastValidationAt: string;
}

export interface CampaignExportPreview {
  eligibility: CampaignExportEligibility;
  domain?: string;
  batch: number;
  limit: number;
  offset: number;
  total: number;
  totalBatches: number;
  rows: CampaignExportRow[];
}

export interface TypoResolutionResult {
  id: number;
  email: string;
  typoSuggestion: string | null;
  typoResolvedEmail: string | null;
  typoResolutionStatus: TypoResolutionStatus | null;
  verificationStatus: VerificationStatus;
}

export interface SendEligibilityAnalytics {
  total: number;
  byEligibility: Record<SendEligibility, number>;
  byReason: Array<{
    reason: string;
    count: number;
    eligibility: SendEligibility;
  }>;
  pendingOlderThan7Days: number;
  reviewNeedsAction: number;
}

@Injectable()
export class EmailsService {
  private readonly logger = new Logger(EmailsService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(EmailSource)
    private readonly emailSourceRepository: Repository<EmailSource>,
    @InjectRepository(BounceRecoveryCandidate)
    private readonly bounceRecoveryRepository: Repository<BounceRecoveryCandidate>,
    private readonly filterValidator: FilterValidator,
    private readonly sendEligibilityService: SendEligibilityService,
  ) {}

  /**
   * Bulk insert emails cu deduplication
   * Folosit de Import Module
   */
  async bulkCreate(
    emails: CreateEmailDto[],
    sourceType: ImportSourceType,
    sourceIdentifier?: string,
  ): Promise<BulkCreateResult> {
    const result: BulkCreateResult = {
      imported: 0,
      duplicates: 0,
      errors: 0,
    };

    // Normalize emails (lowercase, trim)
    const normalizedEmails = emails.map((e) => ({
      ...e,
      email: e.email.toLowerCase().trim(),
    }));

    for (const emailData of normalizedEmails) {
      try {
        if (await this.storeTypoCandidate(emailData, sourceType, sourceIdentifier)) {
          result.errors++;
          continue;
        }

        if (!(await this.isImportCandidateAccepted(emailData.email))) {
          result.errors++;
          continue;
        }

        // Try to insert email
        const emailEntity = this.emailRepository.create({
          ...emailData,
          verificationStatus: VerificationStatus.PENDING,
          qualityScore: 0,
          ...this.sendEligibilityService.buildUpdate({
            verificationStatus: VerificationStatus.PENDING,
            qualityScore: 0,
          }),
        });

        const savedEmail = await this.emailRepository.save(emailEntity).catch((err) => {
          // Duplicate key error
          if (err.code === 'ER_DUP_ENTRY') {
            result.duplicates++;
            return null;
          }
          throw err;
        });

        if (savedEmail) {
          // Create email source record (GDPR tracking)
          await this.emailSourceRepository.save({
            emailId: savedEmail.id,
            sourceType,
            sourceIdentifier,
            consentGiven: true,
            consentTimestamp: emailData.acquisitionDate || new Date(),
          });

          result.imported++;
        }
      } catch (error) {
        this.logger.error(`Failed to import email ${emailData.email}: ${error.message}`);
        result.errors++;
      }
    }

    return result;
  }

  async isImportCandidateAccepted(email: string | null | undefined): Promise<boolean> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail || !this.hasAcceptableEmailShape(normalizedEmail)) {
      return false;
    }

    return !(await this.isSuppressedForImport(normalizedEmail));
  }

  async storeTypoCandidate(
    emailData: CreateEmailDto,
    sourceType: ImportSourceType,
    sourceIdentifier?: string,
    options: StoreTypoCandidateOptions = {},
  ): Promise<boolean> {
    const normalizedEmail = this.normalizeEmail(emailData.email);
    if (!normalizedEmail || !this.hasAcceptableEmailShape(normalizedEmail)) {
      return false;
    }

    const filterResult = this.filterValidator.validate(normalizedEmail);
    const suggestedEmail = this.normalizeEmail(options.suggestedEmail || filterResult.suggestedEmail);
    if (
      !suggestedEmail ||
      !this.hasAcceptableEmailShape(suggestedEmail) ||
      suggestedEmail === normalizedEmail
    ) {
      return false;
    }
    const isForcedSuggestion = suggestedEmail !== filterResult.suggestedEmail;

    let emailRecord = await this.emailRepository.findOne({ where: { email: normalizedEmail } });
    const suppressedStatus = emailRecord
      ? [
          VerificationStatus.INVALID,
          VerificationStatus.DISPOSABLE,
          VerificationStatus.UNSUBSCRIBED,
        ].includes(emailRecord.verificationStatus)
      : false;

    const verificationStatus = suppressedStatus
      ? emailRecord.verificationStatus
      : filterResult.isDisposable
        ? VerificationStatus.DISPOSABLE
        : VerificationStatus.RISKY;
    const qualityScore = suppressedStatus ? emailRecord.qualityScore : filterResult.isDisposable ? 0 : 45;
    const updateData = {
      firstName: emailData.firstName,
      lastName: emailData.lastName,
      phone: emailData.phone,
      country: emailData.country,
      city: emailData.city,
      acquisitionSource: emailData.acquisitionSource || 'typo_review',
      acquisitionDate: emailData.acquisitionDate || new Date(),
      funnelStage: emailData.funnelStage,
      hasValidSyntax: true,
      isDisposable: filterResult.isDisposable,
      isRoleBased: filterResult.isRoleBased,
      hasTypo: true,
      typoSuggestion: suggestedEmail,
      typoResolutionStatus: 'pending' as TypoResolutionStatus,
      typoResolvedEmail: null,
      typoResolvedAt: null,
      typoResolutionNote: null,
      verificationStatus,
      qualityScore,
      smtpErrorMessage: options.smtpErrorMessage ||
        (isForcedSuggestion
          ? 'Customer-name typo detected in email local part; review suggested correction before sending'
          : 'Common-domain typo detected; review suggested correction before sending'),
      lastVerifiedAt: new Date(),
      ...this.sendEligibilityService.buildUpdate({
        verificationStatus,
        qualityScore: Number(qualityScore || 0),
        hasValidSyntax: true,
        isDisposable: filterResult.isDisposable,
        isRoleBased: filterResult.isRoleBased,
        hasTypo: true,
        typoResolutionStatus: 'pending',
      }),
    };

    if (!emailRecord) {
      emailRecord = await this.emailRepository.save(
        this.emailRepository.create({
          email: normalizedEmail,
          emailDomain: normalizedEmail.split('@')[1] || null,
          ...updateData,
        }),
      );
    } else {
      await this.emailRepository.update(emailRecord.id, updateData);
      emailRecord = await this.emailRepository.findOne({ where: { id: emailRecord.id } });
    }

    if (emailRecord && sourceIdentifier) {
      const existingSource = await this.emailSourceRepository.findOne({
        where: {
          emailId: emailRecord.id,
          sourceType,
          sourceIdentifier,
        },
      });

      if (!existingSource) {
        await this.emailSourceRepository.save({
          emailId: emailRecord.id,
          sourceType,
          sourceIdentifier,
          consentGiven: true,
          consentTimestamp: emailData.acquisitionDate || new Date(),
        });
      }
    }

    this.logger.warn(
      `Stored ${normalizedEmail} for typo review. Suggested: ${suggestedEmail}`,
    );

    return true;
  }

  async markAsTestEmail(
    email: string,
    options: { reason?: string; sourceIdentifier?: string } = {},
  ): Promise<Email> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('A valid email address is required');
    }

    let emailRecord = await this.emailRepository.findOne({ where: { email: normalizedEmail } });
    const now = new Date();
    const updateData = {
      verificationStatus: VerificationStatus.INVALID,
      qualityScore: 0,
      hasValidSyntax: false,
      hasValidDns: false,
      hasValidSmtp: false,
      isDisposable: false,
      isRoleBased: false,
      hasTypo: false,
      typoSuggestion: null,
      typoResolutionStatus: 'ignored' as TypoResolutionStatus,
      typoResolvedEmail: null,
      typoResolvedAt: now,
      typoResolutionNote: options.reason || 'Marked as test/ignored from quality gate',
      acquisitionSource: 'quality_gate_test',
      smtpErrorMessage: options.reason || 'Marked as test/ignored from quality gate',
      lastVerifiedAt: now,
      ...this.sendEligibilityService.buildUpdate({
        verificationStatus: VerificationStatus.INVALID,
        qualityScore: 0,
        hasValidSyntax: false,
        hasValidDns: false,
        hasValidSmtp: false,
        isDisposable: false,
        isRoleBased: false,
        hasTypo: false,
        typoResolutionStatus: 'ignored',
      }, ExternalValidationProvider.MANUAL),
    };

    if (!emailRecord) {
      emailRecord = await this.emailRepository.save(
        this.emailRepository.create({
          email: normalizedEmail,
          emailDomain: normalizedEmail.split('@')[1] || null,
          ...updateData,
        }),
      );
    } else {
      await this.emailRepository.update(emailRecord.id, updateData);
      emailRecord = await this.emailRepository.findOne({ where: { id: emailRecord.id } });
    }

    const sourceIdentifier = options.sourceIdentifier || `quality_gate_test_${normalizedEmail}`;
    const existingSource = await this.emailSourceRepository.findOne({
      where: {
        emailId: emailRecord.id,
        sourceType: ImportSourceType.MANUAL,
        sourceIdentifier,
      },
    });

    if (!existingSource) {
      await this.emailSourceRepository.save({
        emailId: emailRecord.id,
        sourceType: ImportSourceType.MANUAL,
        sourceIdentifier,
        consentGiven: false,
        consentTimestamp: new Date(),
      });
    }

    return emailRecord;
  }

  private async isSuppressedForImport(email: string): Promise<boolean> {
    const existingEmail = await this.emailRepository.findOne({ where: { email } });
    if (!existingEmail) {
      return false;
    }

    return [
      VerificationStatus.INVALID,
      VerificationStatus.DISPOSABLE,
      VerificationStatus.UNSUBSCRIBED,
    ].includes(existingEmail.verificationStatus);
  }

  private hasAcceptableEmailShape(email: string): boolean {
    if (!email || !email.includes('@')) {
      return false;
    }

    const [localPart, domain] = email.split('@');
    if (!localPart || !domain || !domain.includes('.')) {
      return false;
    }

    if (
      localPart === 'test' ||
      localPart.startsWith('test+') ||
      localPart === 'client' ||
      localPart === 'unknown' ||
      localPart === 'noemail' ||
      localPart === 'no-email' ||
      localPart === 'no_email'
    ) {
      return false;
    }

    if (
      email === 'test@example.com' ||
      email === 'client@example.com' ||
      email === 'example@example.com' ||
      /^test(\+[^@]+)?@example\./.test(email)
    ) {
      return false;
    }

    return true;
  }

  private normalizeEmail(email: string | null | undefined): string {
    return String(email || '').trim().toLowerCase();
  }

  private csvEscape(value: string | number | null | undefined): string {
    const stringValue = String(value ?? '');
    if (/[",\n\r]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
  }

  /**
   * Get email by ID
   */
  async findOne(id: number): Promise<Email> {
    return this.emailRepository.findOne({
      where: { id },
      relations: ['sources'],
    });
  }

  /**
   * Get email by email address
   */
  async findByEmail(email: string): Promise<Email> {
    return this.emailRepository.findOne({
      where: { email: email.toLowerCase().trim() },
      relations: ['sources'],
    });
  }

  /**
   * Get emails with pagination and filters
   */
  async findAll(options: {
    page?: number;
    limit?: number;
    status?: VerificationStatus;
    minScore?: number;
    search?: string;
    emailDomain?: string;
    hasTypo?: boolean;
    typoResolutionStatus?: TypoResolutionStatus;
    sendEligibility?: SendEligibility;
    doNotSendReason?: string;
  }): Promise<{ data: Email[]; total: number }> {
    const page = options.page || 1;
    const limit = Math.min(options.limit || 100, 1000);
    const skip = (page - 1) * limit;

    const qb = this.emailRepository.createQueryBuilder('email');

    if (options.status) {
      qb.andWhere('email.verificationStatus = :status', { status: options.status });
    }

    if (options.sendEligibility) {
      qb.andWhere('email.sendEligibility = :sendEligibility', {
        sendEligibility: options.sendEligibility,
      });
    }

    if (options.doNotSendReason) {
      qb.andWhere('email.doNotSendReason = :doNotSendReason', {
        doNotSendReason: options.doNotSendReason,
      });
    }

    if (options.minScore) {
      qb.andWhere('email.qualityScore >= :minScore', { minScore: options.minScore });
    }

    if (options.search) {
      qb.andWhere(
        '(email.email LIKE :search OR email.typoSuggestion LIKE :search OR email.typoResolvedEmail LIKE :search OR email.firstName LIKE :search OR email.lastName LIKE :search)',
        { search: `%${options.search}%` },
      );
    }

    if (options.emailDomain) {
      qb.andWhere('email.emailDomain = :emailDomain', { emailDomain: options.emailDomain });
    }

    if (typeof options.hasTypo === 'boolean') {
      qb.andWhere('email.hasTypo = :hasTypo', { hasTypo: options.hasTypo });
    }

    if (options.typoResolutionStatus === 'pending') {
      qb.andWhere(
        '(email.typoResolutionStatus = :typoResolutionStatus OR email.typoResolutionStatus IS NULL)',
        {
          typoResolutionStatus: options.typoResolutionStatus,
        },
      );
    } else if (options.typoResolutionStatus) {
      qb.andWhere('email.typoResolutionStatus = :typoResolutionStatus', {
        typoResolutionStatus: options.typoResolutionStatus,
      });
    }

    const [data, total] = await qb
      .skip(skip)
      .take(limit)
      .orderBy('email.createdAt', 'DESC')
      .getManyAndCount();

    return { data, total };
  }

  async getCampaignExportPreview(options: CampaignExportOptions = {}): Promise<CampaignExportPreview> {
    const eligibility = this.normalizeCampaignEligibility(options.eligibility);
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 5000);
    const batch = Math.max(Number(options.batch) || 1, 1);
    const offset = (batch - 1) * limit;
    const domain = String(options.domain || '').trim().toLowerCase();

    const qb = this.emailRepository
      .createQueryBuilder('email')
      .where('email.sendEligibility = :eligibility', { eligibility });

    if (domain) {
      qb.andWhere('email.emailDomain = :domain', { domain });
    }

    if (eligibility !== SendEligibility.SAFE_TO_SEND) {
      qb.andWhere('email.sendEligibility IN (:...reviewable)', {
        reviewable: [SendEligibility.REVIEW, SendEligibility.PENDING],
      });
    }

    const total = await qb.clone().getCount();
    const emailRows = await qb
      .clone()
      .orderBy('email.id', 'ASC')
      .skip(offset)
      .take(limit)
      .getMany();

    const seen = new Set<string>();
    const rows: CampaignExportRow[] = [];

    for (const emailRecord of emailRows) {
      const email = this.normalizeEmail(emailRecord.email);
      if (!email || !this.hasAcceptableEmailShape(email) || seen.has(email)) {
        continue;
      }

      seen.add(email);
      rows.push({
        email,
        emailId: Number(emailRecord.id),
        customerId: emailRecord.customerId ? Number(emailRecord.customerId) : null,
        firstName: emailRecord.firstName || '',
        lastName: emailRecord.lastName || '',
        emailDomain: emailRecord.emailDomain || email.split('@')[1] || '',
        sendEligibility: emailRecord.sendEligibility,
        doNotSendReason: emailRecord.doNotSendReason || '',
        verificationStatus: emailRecord.verificationStatus,
        qualityScore: Number(emailRecord.qualityScore || 0),
        acquisitionSource: emailRecord.acquisitionSource || '',
        lastValidationSource: emailRecord.lastValidationSource || '',
        lastValidationAt: emailRecord.lastValidationAt
          ? new Date(emailRecord.lastValidationAt).toISOString()
          : '',
      });
    }

    return {
      eligibility,
      domain: domain || undefined,
      batch,
      limit,
      offset,
      total,
      totalBatches: Math.ceil(total / limit),
      rows,
    };
  }

  async buildCampaignCsv(options: CampaignExportOptions = {}): Promise<{
    filename: string;
    csv: string;
    preview: CampaignExportPreview;
  }> {
    const preview = await this.getCampaignExportPreview(options);
    const headers = [
      'email',
      'email_id',
      'customer_id',
      'first_name',
      'last_name',
      'domain',
      'send_eligibility',
      'reason',
      'verification_status',
      'quality_score',
      'acquisition_source',
      'last_validation_source',
      'last_validation_at',
    ];

    const lines = [
      headers.join(','),
      ...preview.rows.map((row) =>
        [
          row.email,
          row.emailId,
          row.customerId || '',
          row.firstName,
          row.lastName,
          row.emailDomain,
          row.sendEligibility,
          row.doNotSendReason,
          row.verificationStatus,
          row.qualityScore,
          row.acquisitionSource,
          row.lastValidationSource,
          row.lastValidationAt,
        ]
          .map((value) => this.csvEscape(value))
          .join(','),
      ),
    ];

    const label = preview.domain
      ? `${preview.eligibility}-${preview.domain.replace(/[^a-z0-9]+/g, '-')}`
      : preview.eligibility;

    return {
      filename: `campaign-${label}-batch-${String(preview.batch).padStart(3, '0')}.csv`,
      csv: `${lines.join('\n')}\n`,
      preview,
    };
  }

  async getNeverBounceExportPreview(
    options: NeverBounceExportOptions,
  ): Promise<NeverBounceExportPreview> {
    const segment = this.normalizeNeverBounceSegment(options.segment);
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 1000);
    const batch = Math.max(Number(options.batch) || 1, 1);
    const offset = (batch - 1) * limit;
    const domain = String(options.domain || '').trim().toLowerCase();

    if (segment === 'domain' && !domain) {
      throw new Error('domain is required for domain NeverBounce exports');
    }

    if (this.isRecoveryNeverBounceSegment(segment)) {
      return this.getRecoveryNeverBounceExportPreview({
        segment,
        batch,
        limit,
        offset,
      });
    }

    const qb = this.emailRepository.createQueryBuilder('email');

    if (segment === 'typo_resolved') {
      qb.where('email.hasTypo = true')
        .andWhere('email.typoResolutionStatus = :acceptedStatus', {
          acceptedStatus: 'accepted',
        })
        .andWhere('email.typoSuggestion IS NOT NULL')
        .andWhere("email.typoSuggestion <> ''")
        .andWhere('email.verificationStatus NOT IN (:...suppressedStatuses)', {
          suppressedStatuses: [
            VerificationStatus.INVALID,
            VerificationStatus.DISPOSABLE,
            VerificationStatus.UNSUBSCRIBED,
          ],
        });
    } else {
      qb.where('email.emailDomain = :domain', { domain })
        .andWhere('(email.hasTypo IS NULL OR email.hasTypo = false)')
        .andWhere('email.verificationStatus NOT IN (:...suppressedStatuses)', {
          suppressedStatuses: [
            VerificationStatus.INVALID,
            VerificationStatus.DISPOSABLE,
            VerificationStatus.UNSUBSCRIBED,
          ],
        });
    }

    const total = await qb.clone().getCount();
    const emailRows = await qb
      .clone()
      .orderBy('email.id', 'ASC')
      .skip(offset)
      .take(limit)
      .getMany();

    const seen = new Set<string>();
    const rows: NeverBounceExportRow[] = [];

    for (const emailRecord of emailRows) {
      const exportEmail =
        segment === 'typo_resolved'
          ? this.normalizeEmail(emailRecord.typoResolvedEmail || emailRecord.typoSuggestion)
          : this.normalizeEmail(emailRecord.email);

      if (!exportEmail || !this.hasAcceptableEmailShape(exportEmail) || seen.has(exportEmail)) {
        continue;
      }

      seen.add(exportEmail);
      rows.push({
        email: exportEmail,
        originalEmail: emailRecord.email,
        emailId: Number(emailRecord.id),
        customerId: emailRecord.customerId ? Number(emailRecord.customerId) : null,
        originalDomain: emailRecord.emailDomain || emailRecord.email.split('@')[1] || '',
        exportDomain: exportEmail.split('@')[1] || '',
        segment,
        verificationStatus: emailRecord.verificationStatus,
        qualityScore: Number(emailRecord.qualityScore || 0),
        acquisitionSource: emailRecord.acquisitionSource || '',
        firstName: emailRecord.firstName || '',
        lastName: emailRecord.lastName || '',
        sendEligibility: emailRecord.sendEligibility,
        doNotSendReason: emailRecord.doNotSendReason || '',
      });
    }

    return {
      segment,
      domain: segment === 'domain' ? domain : undefined,
      batch,
      limit,
      offset,
      total,
      totalBatches: Math.ceil(total / limit),
      rows,
    };
  }

  async buildNeverBounceCsv(options: NeverBounceExportOptions): Promise<{
    filename: string;
    csv: string;
    preview: NeverBounceExportPreview;
  }> {
    const preview = await this.getNeverBounceExportPreview(options);
    const headers = [
      'email',
      'original_email',
      'email_id',
      'customer_id',
      'original_domain',
      'export_domain',
      'segment',
      'verification_status',
      'quality_score',
      'acquisition_source',
      'first_name',
      'last_name',
      'recovery_reason',
      'recovery_confidence',
      'recovery_source',
      'send_eligibility',
      'do_not_send_reason',
    ];

    const lines = [
      headers.join(','),
      ...preview.rows.map((row) =>
        [
          row.email,
          row.originalEmail,
          row.emailId,
          row.customerId || '',
          row.originalDomain,
          row.exportDomain,
          row.segment,
          row.verificationStatus,
          row.qualityScore,
          row.acquisitionSource,
          row.firstName,
          row.lastName,
          row.recoveryReason || '',
          row.recoveryConfidence || '',
          row.recoverySource || '',
          row.sendEligibility || '',
          row.doNotSendReason || '',
        ]
          .map((value) => this.csvEscape(value))
          .join(','),
      ),
    ];

    const label =
      preview.segment === 'domain'
        ? `domain-${String(preview.domain).replace(/[^a-z0-9]+/g, '-')}`
        : preview.segment.replace(/_/g, '-');

    return {
      filename: `neverbounce-${label}-batch-${String(preview.batch).padStart(3, '0')}.csv`,
      csv: `${lines.join('\n')}\n`,
      preview,
    };
  }

  private async getRecoveryNeverBounceExportPreview(options: {
    segment: NeverBounceExportSegment;
    batch: number;
    limit: number;
    offset: number;
  }): Promise<NeverBounceExportPreview> {
    const qb = this.bounceRecoveryRepository
      .createQueryBuilder('recovery')
      .innerJoin(
        Email,
        'email',
        "email.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(recovery.metadata, '$.approvedEmailId')) AS UNSIGNED)",
      )
      .where('recovery.status = :status', { status: BounceRecoveryStatus.APPROVED });

    if (options.segment === 'recovery_domain_typo') {
      qb.andWhere('recovery.reason = :reason', { reason: BounceRecoveryReason.DOMAIN_TYPO });
    }

    if (options.segment === 'recovery_name_typo') {
      qb.andWhere('recovery.reason = :reason', { reason: BounceRecoveryReason.NAME_LOCALPART_TYPO });
    }

    if (options.segment === 'recovery_manual_edit') {
      qb.andWhere("JSON_EXTRACT(recovery.metadata, '$.manuallyEditedSuggestion') = true");
    }

    const total = await qb.clone().getCount();
    const rawRows = await qb
      .clone()
      .select([
        'recovery.id AS recoveryId',
        'recovery.bouncedEmail AS bouncedEmail',
        'recovery.suggestedEmail AS suggestedEmail',
        'recovery.reason AS recoveryReason',
        'recovery.confidence AS recoveryConfidence',
        'recovery.source AS recoverySource',
        'email.id AS emailId',
        'email.customer_id AS customerId',
        'email.email AS email',
        'email.email_domain AS emailDomain',
        'email.verificationStatus AS verificationStatus',
        'email.qualityScore AS qualityScore',
        'email.acquisitionSource AS acquisitionSource',
        'email.firstName AS firstName',
        'email.lastName AS lastName',
        'email.sendEligibility AS sendEligibility',
        'email.doNotSendReason AS doNotSendReason',
      ])
      .orderBy('recovery.id', 'ASC')
      .skip(options.offset)
      .take(options.limit)
      .getRawMany();

    const seen = new Set<string>();
    const rows: NeverBounceExportRow[] = [];

    for (const raw of rawRows) {
      const exportEmail = this.normalizeEmail(raw.suggestedEmail || raw.email);
      if (!exportEmail || !this.hasAcceptableEmailShape(exportEmail) || seen.has(exportEmail)) {
        continue;
      }

      seen.add(exportEmail);
      rows.push({
        email: exportEmail,
        originalEmail: raw.bouncedEmail || raw.email,
        emailId: Number(raw.emailId),
        customerId: raw.customerId ? Number(raw.customerId) : null,
        originalDomain: String(raw.bouncedEmail || raw.email).split('@')[1] || raw.emailDomain || '',
        exportDomain: exportEmail.split('@')[1] || '',
        segment: options.segment,
        verificationStatus: raw.verificationStatus,
        qualityScore: Number(raw.qualityScore || 0),
        acquisitionSource: raw.acquisitionSource || '',
        firstName: raw.firstName || '',
        lastName: raw.lastName || '',
        recoveryReason: raw.recoveryReason || '',
        recoveryConfidence: raw.recoveryConfidence || '',
        recoverySource: raw.recoverySource || '',
        sendEligibility: raw.sendEligibility,
        doNotSendReason: raw.doNotSendReason || '',
      });
    }

    return {
      segment: options.segment,
      batch: options.batch,
      limit: options.limit,
      offset: options.offset,
      total,
      totalBatches: Math.ceil(total / options.limit),
      rows,
    };
  }

  private normalizeNeverBounceSegment(segment?: NeverBounceExportSegment): NeverBounceExportSegment {
    const allowed: NeverBounceExportSegment[] = [
      'domain',
      'typo_resolved',
      'recovery_all',
      'recovery_domain_typo',
      'recovery_name_typo',
      'recovery_manual_edit',
    ];

    return allowed.includes(segment as NeverBounceExportSegment)
      ? segment as NeverBounceExportSegment
      : 'typo_resolved';
  }

  private isRecoveryNeverBounceSegment(segment: NeverBounceExportSegment): boolean {
    return segment.startsWith('recovery_');
  }

  private normalizeCampaignEligibility(
    eligibility?: CampaignExportEligibility,
  ): CampaignExportEligibility {
    if (eligibility === SendEligibility.REVIEW || eligibility === SendEligibility.PENDING) {
      return eligibility;
    }

    return SendEligibility.SAFE_TO_SEND;
  }

  async resolveTypoCandidate(
    emailId: number,
    options: {
      action: TypoResolutionAction;
      resolvedEmail?: string;
      note?: string;
    },
  ): Promise<TypoResolutionResult> {
    const emailRecord = await this.emailRepository.findOne({ where: { id: emailId } });
    const hasExplicitCorrection = options.action === 'accept' && Boolean(options.resolvedEmail?.trim());
    if (
      !emailRecord ||
      (!hasExplicitCorrection && (!emailRecord.hasTypo || !emailRecord.typoSuggestion))
    ) {
      throw new Error('Typo candidate was not found');
    }

    const now = new Date();

    if (options.action === 'accept') {
      const resolvedEmail = this.normalizeEmail(options.resolvedEmail || emailRecord.typoSuggestion);
      if (!resolvedEmail || !this.hasAcceptableEmailShape(resolvedEmail)) {
        throw new Error('Resolved email is not valid enough to accept');
      }

      if (resolvedEmail === this.normalizeEmail(emailRecord.email)) {
        throw new Error('Corrected email must be different from the original email');
      }

      const filterResult = this.filterValidator.validate(resolvedEmail);
      if (filterResult.hasSuggestedCorrection) {
        throw new Error('Resolved email still looks like a typo');
      }

      const updateData = {
        hasTypo: true,
        typoSuggestion: resolvedEmail,
        typoResolutionStatus: 'accepted' as TypoResolutionStatus,
        typoResolvedEmail: resolvedEmail,
        typoResolvedAt: now,
        typoResolutionNote: options.note || null,
        verificationStatus: VerificationStatus.RISKY,
        qualityScore: Math.max(Number(emailRecord.qualityScore || 0), 55),
        smtpErrorMessage: 'Typo suggestion accepted; external validation required before sending',
        lastVerifiedAt: now,
      };
      await this.emailRepository.update(emailRecord.id, {
        ...updateData,
        ...this.sendEligibilityService.buildUpdate({
          verificationStatus: updateData.verificationStatus,
          qualityScore: updateData.qualityScore,
          hasTypo: true,
          typoResolutionStatus: updateData.typoResolutionStatus,
          isDisposable: emailRecord.isDisposable,
          isRoleBased: emailRecord.isRoleBased,
        }, ExternalValidationProvider.MANUAL),
      });
    } else if (options.action === 'ignore') {
      const updateData = {
        typoResolutionStatus: 'ignored' as TypoResolutionStatus,
        typoResolvedEmail: null,
        typoResolvedAt: now,
        typoResolutionNote: options.note || 'Ignored as test, spam, or unusable typo',
        verificationStatus: VerificationStatus.INVALID,
        qualityScore: 0,
        smtpErrorMessage: 'Typo candidate ignored and excluded from sending flows',
        lastVerifiedAt: now,
      };
      await this.emailRepository.update(emailRecord.id, {
        ...updateData,
        ...this.sendEligibilityService.buildUpdate({
          verificationStatus: updateData.verificationStatus,
          qualityScore: updateData.qualityScore,
          hasTypo: true,
          typoResolutionStatus: updateData.typoResolutionStatus,
          isDisposable: emailRecord.isDisposable,
          isRoleBased: emailRecord.isRoleBased,
        }, ExternalValidationProvider.MANUAL),
      });
    } else {
      const updateData = {
        typoResolutionStatus: 'pending' as TypoResolutionStatus,
        typoResolvedEmail: null,
        typoResolvedAt: null,
        typoResolutionNote: options.note || null,
        verificationStatus: VerificationStatus.RISKY,
        qualityScore: Math.max(Number(emailRecord.qualityScore || 0), 45),
        smtpErrorMessage: 'Typo candidate reset for review',
        lastVerifiedAt: now,
      };
      await this.emailRepository.update(emailRecord.id, {
        ...updateData,
        ...this.sendEligibilityService.buildUpdate({
          verificationStatus: updateData.verificationStatus,
          qualityScore: updateData.qualityScore,
          hasTypo: true,
          typoResolutionStatus: updateData.typoResolutionStatus,
          isDisposable: emailRecord.isDisposable,
          isRoleBased: emailRecord.isRoleBased,
        }, ExternalValidationProvider.MANUAL),
      });
    }

    const updated = await this.emailRepository.findOneOrFail({ where: { id: emailId } });

    return {
      id: Number(updated.id),
      email: updated.email,
      typoSuggestion: updated.typoSuggestion,
      typoResolvedEmail: updated.typoResolvedEmail,
      typoResolutionStatus: updated.typoResolutionStatus,
      verificationStatus: updated.verificationStatus,
    };
  }

  async resolveTypoCandidatesBulk(options: {
    emailIds: number[];
    action: TypoResolutionAction;
  }): Promise<{
    requested: number;
    resolved: number;
    errors: number;
  }> {
    const emailIds = [...new Set((options.emailIds || []).map((id) => Number(id)).filter(Boolean))].slice(
      0,
      1000,
    );
    const result = {
      requested: emailIds.length,
      resolved: 0,
      errors: 0,
    };

    for (const emailId of emailIds) {
      try {
        await this.resolveTypoCandidate(emailId, { action: options.action });
        result.resolved++;
      } catch {
        result.errors++;
      }
    }

    return result;
  }

  /**
   * Update email verification status
   */
  async updateVerificationStatus(
    emailId: number,
    data: {
      hasValidSyntax?: boolean;
      hasValidDns?: boolean;
      hasValidSmtp?: boolean;
      isDisposable?: boolean;
      isRoleBased?: boolean;
      hasTypo?: boolean;
      typoSuggestion?: string;
      verificationStatus?: VerificationStatus;
      qualityScore?: number;
      smtpResultCode?: string;
      smtpErrorMessage?: string;
    },
  ): Promise<void> {
    const existingEmail = await this.emailRepository.findOne({ where: { id: emailId } });
    const merged = {
      ...(existingEmail || {}),
      ...data,
    };

    await this.emailRepository.update(emailId, {
      ...data,
      ...this.sendEligibilityService.buildUpdate({
        verificationStatus: merged.verificationStatus,
        qualityScore: Number(merged.qualityScore || 0),
        gmailCategory: merged.gmailCategory,
        hasTypo: merged.hasTypo,
        typoResolutionStatus: merged.typoResolutionStatus,
        isDisposable: merged.isDisposable,
        isRoleBased: merged.isRoleBased,
        hasValidSyntax: merged.hasValidSyntax,
        hasValidDns: merged.hasValidDns,
        hasValidSmtp: merged.hasValidSmtp,
      }, ExternalValidationProvider.MANUAL),
      lastVerifiedAt: new Date(),
    });
  }

  /**
   * Get count by status
   */
  async getCountByStatus(): Promise<Record<VerificationStatus, number>> {
    const results = await this.emailRepository
      .createQueryBuilder('email')
      .select('email.verificationStatus', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('email.verificationStatus')
      .getRawMany();

    const counts = {} as Record<VerificationStatus, number>;

    // Initialize all statuses with 0
    Object.values(VerificationStatus).forEach((status) => {
      counts[status] = 0;
    });

    // Fill in actual counts
    results.forEach((row) => {
      counts[row.status] = parseInt(row.count, 10);
    });

    return counts;
  }

  /**
   * Get total count
   */
  async getTotalCount(): Promise<number> {
    return this.emailRepository.count();
  }

  /**
   * Get pending emails for verification (paginated)
   */
  async getPendingEmails(limit: number = 1000): Promise<Email[]> {
    return this.emailRepository.find({
      where: { verificationStatus: VerificationStatus.PENDING },
      take: limit,
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Get email domains with counts (for dropdown filter)
   */
  async getEmailDomains(limit: number = 100): Promise<{ domain: string; count: number }[]> {
    const results = await this.emailRepository
      .createQueryBuilder('email')
      .select('email.emailDomain', 'domain')
      .addSelect('COUNT(*)', 'count')
      .where('email.emailDomain IS NOT NULL')
      .groupBy('email.emailDomain')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany();

    return results.map((row) => ({
      domain: row.domain,
      count: parseInt(row.count, 10),
    }));
  }

  /**
   * Get overview analytics
   */
  async getOverviewAnalytics(): Promise<{
    total: number;
    withCustomers: number;
    withoutCustomers: number;
    averageQualityScore: number;
    byStatus: Record<VerificationStatus, number>;
  }> {
    const [total, withCustomers, averageScoreResult, byStatus] = await Promise.all([
      this.emailRepository.count(),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.customerId IS NOT NULL')
        .getCount(),
      this.emailRepository
        .createQueryBuilder('email')
        .select('AVG(email.qualityScore)', 'average')
        .getRawOne(),
      this.getCountByStatus(),
    ]);

    return {
      total,
      withCustomers,
      withoutCustomers: total - withCustomers,
      averageQualityScore: parseFloat(averageScoreResult?.average || '0'),
      byStatus,
    };
  }

  /**
   * Get quality score distribution
   */
  async getQualityScoreDistribution(): Promise<{
    range: string;
    count: number;
    percentage: number;
  }[]> {
    const total = await this.emailRepository.count();

    const results = await this.emailRepository
      .createQueryBuilder('email')
      .select(
        `CASE
          WHEN qualityScore >= 0 AND qualityScore < 20 THEN '0-20'
          WHEN qualityScore >= 20 AND qualityScore < 40 THEN '20-40'
          WHEN qualityScore >= 40 AND qualityScore < 60 THEN '40-60'
          WHEN qualityScore >= 60 AND qualityScore < 80 THEN '60-80'
          WHEN qualityScore >= 80 AND qualityScore <= 100 THEN '80-100'
        END`,
        'score_range'
      )
      .addSelect('COUNT(*)', 'count')
      .groupBy('score_range')
      .orderBy('score_range', 'ASC')
      .getRawMany();

    return results.map((row) => {
      const count = parseInt(row.count, 10);
      return {
        range: row.score_range || 'unknown',
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      };
    });
  }

  /**
   * Get customer linkage rate by domain
   */
  async getCustomerLinkageByDomain(): Promise<{
    domain: string;
    total: number;
    withCustomers: number;
    linkageRate: number;
  }[]> {
    const results = await this.emailRepository
      .createQueryBuilder('email')
      .select('email.emailDomain', 'domain')
      .addSelect('COUNT(*)', 'total')
      .addSelect('SUM(CASE WHEN email.customerId IS NOT NULL THEN 1 ELSE 0 END)', 'withCustomers')
      .where('email.emailDomain IS NOT NULL')
      .groupBy('email.emailDomain')
      .having('SUM(CASE WHEN email.customerId IS NOT NULL THEN 1 ELSE 0 END) > 0')
      .orderBy('withCustomers', 'DESC')
      .getRawMany();

    return results.map((row) => {
      const total = parseInt(row.total, 10);
      const withCustomers = parseInt(row.withCustomers, 10);
      return {
        domain: row.domain,
        total,
        withCustomers,
        linkageRate: total > 0 ? (withCustomers / total) * 100 : 0,
      };
    });
  }

  /**
   * Get email provider analytics
   */
  async getEmailProviderAnalytics(): Promise<{
    provider: string;
    count: number;
    percentage: number;
  }[]> {
    const total = await this.emailRepository.count();

    const results = await this.emailRepository
      .createQueryBuilder('email')
      .select(
        `CASE
          WHEN email.emailDomain LIKE '%gmail.%' THEN 'Gmail'
          WHEN email.emailDomain LIKE '%yahoo.%' THEN 'Yahoo'
          WHEN email.emailDomain LIKE '%hotmail.%' OR email.emailDomain LIKE '%outlook.%' OR email.emailDomain LIKE '%live.%' THEN 'Outlook'
          WHEN email.emailDomain LIKE '%icloud.%' OR email.emailDomain LIKE '%me.com' THEN 'iCloud'
          WHEN email.emailDomain LIKE '%aol.%' THEN 'AOL'
          WHEN email.emailDomain LIKE '%protonmail.%' OR email.emailDomain LIKE '%proton.me' THEN 'ProtonMail'
          ELSE 'Other'
        END`,
        'provider'
      )
      .addSelect('COUNT(*)', 'count')
      .groupBy('provider')
      .orderBy('count', 'DESC')
      .getRawMany();

    return results.map((row) => {
      const count = parseInt(row.count, 10);
      return {
        provider: row.provider,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      };
    });
  }

  /**
   * Get risk assessment summary
   */
  async getRiskAssessment(): Promise<{
    disposableEmails: number;
    roleBasedEmails: number;
    lowQualityEmails: number;
    totalRiskyEmails: number;
  }> {
    const [disposableEmails, roleBasedEmails, lowQualityEmails] = await Promise.all([
      this.emailRepository.count({ where: { isDisposable: true } }),
      this.emailRepository.count({ where: { isRoleBased: true } }),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.qualityScore < 40')
        .getCount(),
    ]);

    return {
      disposableEmails,
      roleBasedEmails,
      lowQualityEmails,
      totalRiskyEmails: disposableEmails + roleBasedEmails + lowQualityEmails,
    };
  }

  /**
   * Get deliverability score analytics
   */
  async getDeliverabilityScore(): Promise<{
    safeToSend: number;
    risky: number;
    doNotSend: number;
  }> {
    const [safeToSend, risky, doNotSend] = await Promise.all([
      this.emailRepository.count({
        where: { sendEligibility: SendEligibility.SAFE_TO_SEND },
      }),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.sendEligibility IN (:...statuses)', {
          statuses: [SendEligibility.REVIEW, SendEligibility.PENDING],
        })
        .getCount(),
      this.emailRepository.count({
        where: { sendEligibility: SendEligibility.DO_NOT_SEND },
      }),
    ]);

    return {
      safeToSend,
      risky,
      doNotSend,
    };
  }

  async getSendEligibilityAnalytics(): Promise<SendEligibilityAnalytics> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      total,
      eligibilityRows,
      reasonRows,
      pendingOlderThan7Days,
      reviewNeedsAction,
    ] = await Promise.all([
      this.emailRepository.count(),
      this.emailRepository
        .createQueryBuilder('email')
        .select('email.sendEligibility', 'eligibility')
        .addSelect('COUNT(*)', 'count')
        .groupBy('email.sendEligibility')
        .getRawMany(),
      this.emailRepository
        .createQueryBuilder('email')
        .select('email.doNotSendReason', 'reason')
        .addSelect('email.sendEligibility', 'eligibility')
        .addSelect('COUNT(*)', 'count')
        .where('email.doNotSendReason IS NOT NULL')
        .andWhere("email.doNotSendReason <> ''")
        .groupBy('email.doNotSendReason')
        .addGroupBy('email.sendEligibility')
        .orderBy('count', 'DESC')
        .limit(12)
        .getRawMany(),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.sendEligibility = :eligibility', {
          eligibility: SendEligibility.PENDING,
        })
        .andWhere('email.createdAt < :sevenDaysAgo', { sevenDaysAgo })
        .getCount(),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.sendEligibility = :eligibility', {
          eligibility: SendEligibility.REVIEW,
        })
        .getCount(),
    ]);

    const byEligibility = {} as Record<SendEligibility, number>;
    Object.values(SendEligibility).forEach((eligibility) => {
      byEligibility[eligibility] = 0;
    });

    eligibilityRows.forEach((row) => {
      const eligibility = row.eligibility || SendEligibility.PENDING;
      if (Object.values(SendEligibility).includes(eligibility)) {
        byEligibility[eligibility] = Number(row.count || 0);
      }
    });

    return {
      total,
      byEligibility,
      byReason: reasonRows.map((row) => ({
        reason: row.reason || 'unknown',
        count: Number(row.count || 0),
        eligibility: row.eligibility || SendEligibility.PENDING,
      })),
      pendingOlderThan7Days,
      reviewNeedsAction,
    };
  }
}
