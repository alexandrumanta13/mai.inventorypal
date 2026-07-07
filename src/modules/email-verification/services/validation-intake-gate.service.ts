import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import { EmailsService, CreateEmailDto } from '@modules/emails/services/emails.service';
import { ImportSourceType } from '@shared/enums/import-source.enum';
import { SendEligibility } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { PUBLIC_MAILBOX_DOMAINS_CORE_RO } from '@shared/email-domain-classification';
import { FilterValidator } from '../validators/filter.validator';
import { SyntaxValidator } from '../validators/syntax.validator';
import { VerificationJobData } from '../processors/verification.processor';

export type IntakeDecisionType =
  | 'accepted_pending_validation'
  | 'needs_typo_review'
  | 'needs_manual_review'
  | 'blocked';

export type IntakeReasonCode =
  | 'accepted'
  | 'empty'
  | 'invalid_shape'
  | 'invalid_syntax'
  | 'test_or_placeholder'
  | 'existing_suppressed'
  | 'common_domain_typo'
  | 'name_localpart_typo'
  | 'disposable'
  | 'role_based';

export interface IntakeDecision {
  accepted: boolean;
  decision: IntakeDecisionType;
  normalizedEmail: string;
  reasonCode: IntakeReasonCode;
  reason: string;
  suggestedEmail?: string;
  isDisposable?: boolean;
  isRoleBased?: boolean;
  existingStatus?: VerificationStatus;
}

export interface IntakeOverview {
  totals: {
    emails: number;
    pendingValidation: number;
    safeToSend: number;
    riskyOrReview: number;
    doNotSend: number;
    typoReview: number;
    bounceInvalid: number;
  };
  byStatus: Record<string, number>;
  topCommercialDomains: Array<{
    domain: string;
    count: number;
    pendingValidation: number;
    validated: number;
  }>;
}

@Injectable()
export class ValidationIntakeGateService {
  private readonly logger = new Logger(ValidationIntakeGateService.name);

  private readonly blockedLocalParts = new Set([
    'test',
    'client',
    'unknown',
    'noemail',
    'no-email',
    'no_email',
  ]);

  private readonly publicMailboxDomains = PUBLIC_MAILBOX_DOMAINS_CORE_RO;

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectQueue('email-verification')
    private readonly verificationQueue: Queue<VerificationJobData>,
    private readonly emailsService: EmailsService,
    private readonly syntaxValidator: SyntaxValidator,
    private readonly filterValidator: FilterValidator,
  ) {}

  async evaluate(
    email: string | null | undefined,
    _context: { firstName?: string | null; lastName?: string | null; fullName?: string | null } = {},
  ): Promise<IntakeDecision> {
    const normalizedEmail = this.normalizeEmail(email);

    if (!normalizedEmail) {
      return this.blocked('', 'empty', 'Email is empty');
    }

    if (!this.hasBasicShape(normalizedEmail)) {
      return this.blocked(normalizedEmail, 'invalid_shape', 'Email shape is not importable');
    }

    const syntaxResult = this.syntaxValidator.validate(normalizedEmail);
    if (!syntaxResult.isValid) {
      return this.blocked(
        normalizedEmail,
        'invalid_syntax',
        syntaxResult.reason || 'Invalid email syntax',
      );
    }

    const [localPart, domain] = normalizedEmail.split('@');
    if (
      this.blockedLocalParts.has(localPart) ||
      localPart.startsWith('test+') ||
      normalizedEmail === 'test@example.com' ||
      normalizedEmail === 'client@example.com' ||
      normalizedEmail === 'example@example.com' ||
      /^test(\+[^@]+)?@example\./.test(normalizedEmail)
    ) {
      return this.blocked(
        normalizedEmail,
        'test_or_placeholder',
        'Known test or placeholder address',
      );
    }

    const existingEmail = await this.emailRepository.findOne({ where: { email: normalizedEmail } });
    if (
      existingEmail &&
      [
        VerificationStatus.INVALID,
        VerificationStatus.DISPOSABLE,
        VerificationStatus.UNSUBSCRIBED,
      ].includes(existingEmail.verificationStatus)
    ) {
      return {
        accepted: false,
        decision: 'blocked',
        normalizedEmail,
        reasonCode: 'existing_suppressed',
        reason: `Existing email is suppressed as ${existingEmail.verificationStatus}`,
        existingStatus: existingEmail.verificationStatus,
      };
    }

    const filterResult = this.filterValidator.validate(normalizedEmail);
    if (filterResult.hasSuggestedCorrection && filterResult.suggestedEmail) {
      return {
        accepted: false,
        decision: 'needs_typo_review',
        normalizedEmail,
        reasonCode: 'common_domain_typo',
        reason: 'Common-domain typo candidate',
        suggestedEmail: filterResult.suggestedEmail,
        isDisposable: filterResult.isDisposable,
        isRoleBased: filterResult.isRoleBased,
        existingStatus: existingEmail?.verificationStatus,
      };
    }

    if (filterResult.isDisposable) {
      return {
        accepted: false,
        decision: 'blocked',
        normalizedEmail,
        reasonCode: 'disposable',
        reason: filterResult.reason || 'Disposable email domain',
        isDisposable: true,
        isRoleBased: filterResult.isRoleBased,
        existingStatus: existingEmail?.verificationStatus,
      };
    }

    if (filterResult.isRoleBased) {
      return {
        accepted: true,
        decision: 'needs_manual_review',
        normalizedEmail,
        reasonCode: 'role_based',
        reason: filterResult.reason || 'Role-based email address',
        isDisposable: false,
        isRoleBased: true,
        existingStatus: existingEmail?.verificationStatus,
      };
    }

    return {
      accepted: true,
      decision: 'accepted_pending_validation',
      normalizedEmail,
      reasonCode: 'accepted',
      reason: domain ? `Accepted from ${domain}; queued for validation` : 'Accepted; queued for validation',
      isDisposable: false,
      isRoleBased: false,
      existingStatus: existingEmail?.verificationStatus,
    };
  }

  async prepareImportCandidate(
    emailData: CreateEmailDto,
    sourceType: ImportSourceType,
    sourceIdentifier?: string,
  ): Promise<IntakeDecision> {
    const decision = await this.evaluate(emailData.email, {
      firstName: emailData.firstName,
      lastName: emailData.lastName,
    });

    if (decision.decision === 'needs_typo_review') {
      await this.emailsService.storeTypoCandidate(
        {
          ...emailData,
          email: decision.normalizedEmail,
        },
        sourceType,
        sourceIdentifier,
        {
          suggestedEmail: decision.suggestedEmail,
          reason: decision.reasonCode,
        },
      );
    }

    if (decision.decision === 'blocked') {
      this.logger.warn(
        `Blocked intake candidate ${decision.normalizedEmail || '(empty)'}: ${decision.reason}`,
      );
    }

    return decision;
  }

  async queueValidation(email: string, options: { skipSmtp?: boolean } = {}): Promise<boolean> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      return false;
    }

    const emailRecord = await this.emailRepository.findOne({ where: { email: normalizedEmail } });
    if (!emailRecord) {
      return false;
    }

    if (
      [
        VerificationStatus.INVALID,
        VerificationStatus.DISPOSABLE,
        VerificationStatus.UNSUBSCRIBED,
      ].includes(emailRecord.verificationStatus) ||
      emailRecord.hasTypo
    ) {
      return false;
    }

    await this.verificationQueue.add(
      'verify-email',
      {
        email: normalizedEmail,
        skipSmtp: options.skipSmtp || false,
      },
      {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    );

    return true;
  }

  async getOverview(): Promise<IntakeOverview> {
    const [
      total,
      pendingValidation,
      safeToSend,
      riskyOrReview,
      doNotSend,
      typoReview,
      bounceInvalid,
      statusRows,
      topDomainRows,
    ] = await Promise.all([
      this.emailRepository.count(),
      this.emailRepository.count({ where: { verificationStatus: VerificationStatus.PENDING } }),
      this.emailRepository.count({ where: { sendEligibility: SendEligibility.SAFE_TO_SEND } }),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.sendEligibility IN (:...statuses)', {
          statuses: [SendEligibility.REVIEW, SendEligibility.PENDING],
        })
        .getCount(),
      this.emailRepository.count({ where: { sendEligibility: SendEligibility.DO_NOT_SEND } }),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.hasTypo = true')
        .andWhere(
          '(email.typoResolutionStatus IS NULL OR email.typoResolutionStatus = :status)',
          { status: 'pending' },
        )
        .getCount(),
      this.emailRepository
        .createQueryBuilder('email')
        .where('email.gmailCategory = :category', { category: 'bounce' })
        .orWhere('email.smtpErrorMessage LIKE :bounce', { bounce: '%bounce%' })
        .getCount(),
      this.emailRepository
        .createQueryBuilder('email')
        .select('email.verificationStatus', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('email.verificationStatus')
        .getRawMany(),
      this.emailRepository
        .createQueryBuilder('email')
        .select('email.emailDomain', 'domain')
        .addSelect('COUNT(*)', 'count')
        .addSelect(
          'SUM(CASE WHEN email.verificationStatus = :pendingStatus THEN 1 ELSE 0 END)',
          'pendingValidation',
        )
        .addSelect(
          'SUM(CASE WHEN email.verificationStatus = :validStatus THEN 1 ELSE 0 END)',
          'validated',
        )
        .where('email.emailDomain IN (:...domains)', { domains: this.publicMailboxDomains })
        .setParameters({
          pendingStatus: VerificationStatus.PENDING,
          validStatus: VerificationStatus.VALID,
        })
        .groupBy('email.emailDomain')
        .orderBy('count', 'DESC')
        .limit(12)
        .getRawMany(),
    ]);

    const byStatus = statusRows.reduce((acc, row) => {
      acc[row.status || 'unknown'] = Number(row.count || 0);
      return acc;
    }, {} as Record<string, number>);

    return {
      totals: {
        emails: total,
        pendingValidation,
        safeToSend,
        riskyOrReview,
        doNotSend,
        typoReview,
        bounceInvalid,
      },
      byStatus,
      topCommercialDomains: topDomainRows.map((row) => ({
        domain: row.domain,
        count: Number(row.count || 0),
        pendingValidation: Number(row.pendingValidation || 0),
        validated: Number(row.validated || 0),
      })),
    };
  }

  private blocked(
    normalizedEmail: string,
    reasonCode: IntakeReasonCode,
    reason: string,
  ): IntakeDecision {
    return {
      accepted: false,
      decision: 'blocked',
      normalizedEmail,
      reasonCode,
      reason,
    };
  }

  private hasBasicShape(email: string): boolean {
    if (!email || !email.includes('@')) {
      return false;
    }

    const [localPart, domain] = email.split('@');
    return !!localPart && !!domain && domain.includes('.');
  }

  private normalizeEmail(email: string | null | undefined): string {
    return String(email || '')
      .trim()
      .toLowerCase()
      .replace(/[\u0000-\u001f\u007f\s]+/g, '');
  }
}
