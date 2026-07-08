import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { validate as validateEmail } from 'email-validator';
import { Brackets, Repository } from 'typeorm';
import { Customer } from '@modules/customers/entities/customer.entity';
import { Email } from '@modules/emails/entities/email.entity';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { extractEmailDomain, isPublicMailboxDomain } from '@shared/email-domain-classification';
import { VerificationJobData } from '../processors/verification.processor';
import { FilterValidator } from '../validators/filter.validator';
import {
  BounceRecoveryCandidate,
  BounceRecoveryReason,
  BounceRecoveryStatus,
} from '../entities/bounce-recovery-candidate.entity';

export interface BounceRecoveryCreateContext {
  bouncedAt?: Date;
  source?: string;
  messageId?: string;
  subject?: string;
  from?: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}

export interface BounceRecoveryCandidatePreview {
  bouncedEmail: string;
  suggestedEmail: string;
  reason: BounceRecoveryReason;
  confidence: 'high' | 'medium';
  emailId?: number | null;
  customerId?: number | null;
  existingSuggestedStatus?: VerificationStatus | null;
}

@Injectable()
export class BounceRecoveryService {
  private readonly logger = new Logger(BounceRecoveryService.name);

  constructor(
    @InjectRepository(BounceRecoveryCandidate)
    private readonly bounceRecoveryRepository: Repository<BounceRecoveryCandidate>,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    private readonly filterValidator: FilterValidator,
    private readonly sendEligibilityService: SendEligibilityService,
    @InjectQueue('email-verification')
    private readonly verificationQueue: Queue<VerificationJobData>,
  ) {}

  async createCandidateFromBounce(
    bouncedEmail: string,
    context: BounceRecoveryCreateContext = {},
    options: { dryRun?: boolean } = {},
  ): Promise<BounceRecoveryCandidatePreview | null> {
    const preview = await this.buildCandidatePreview(bouncedEmail, context);
    if (!preview || options.dryRun) {
      return preview;
    }

    const existing = await this.bounceRecoveryRepository.findOne({
      where: {
        bouncedEmail: preview.bouncedEmail,
        suggestedEmail: preview.suggestedEmail,
        status: BounceRecoveryStatus.PENDING,
      },
    });

    const metadata = {
      messageId: context.messageId || null,
      subject: context.subject || null,
      from: context.from || null,
      source: context.source || 'gmail_bounce',
      existingSuggestedStatus: preview.existingSuggestedStatus || null,
      firstName: context.firstName || null,
      lastName: context.lastName || null,
      fullName: context.fullName || null,
    };

    if (existing) {
      await this.bounceRecoveryRepository.update(existing.id, {
        emailId: preview.emailId || existing.emailId,
        customerId: preview.customerId || existing.customerId,
        reason: preview.reason,
        confidence: preview.confidence,
        bouncedAt: context.bouncedAt || existing.bouncedAt,
        metadata: {
          ...(existing.metadata || {}),
          ...metadata,
        },
      });
      return preview;
    }

    await this.bounceRecoveryRepository.save(
      this.bounceRecoveryRepository.create({
        emailId: preview.emailId || null,
        customerId: preview.customerId || null,
        bouncedEmail: preview.bouncedEmail,
        suggestedEmail: preview.suggestedEmail,
        reason: preview.reason,
        confidence: preview.confidence,
        status: BounceRecoveryStatus.PENDING,
        source: context.source || 'gmail_bounce',
        bouncedAt: context.bouncedAt || null,
        metadata,
      }),
    );

    this.logger.warn(
      `Stored bounce recovery candidate ${preview.bouncedEmail} -> ${preview.suggestedEmail} (${preview.reason})`,
    );

    return preview;
  }

  async backfillFromExistingBounces(options: {
    limit?: number;
    dryRun?: boolean;
  } = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 10000);
    const dryRun = options.dryRun !== false;

    const rows = await this.emailRepository
      .createQueryBuilder('email')
      .where(new Brackets((qb) => {
        qb.where('email.gmailCategory = :category', { category: 'bounce' })
          .orWhere('email.smtpErrorMessage LIKE :gmailBounce', { gmailBounce: '%Bounce-back%' })
          .orWhere(new Brackets((elasticQb) => {
            elasticQb
              .where('email.lastValidationSource = :elasticSource', {
                elasticSource: ExternalValidationProvider.ELASTIC_EMAIL,
              })
              .andWhere('email.verificationStatus = :invalidStatus', {
                invalidStatus: VerificationStatus.INVALID,
              })
              .andWhere('email.sendEligibility = :doNotSend', {
                doNotSend: SendEligibility.DO_NOT_SEND,
              })
              .andWhere('email.smtpErrorMessage LIKE :elasticBounce', {
                elasticBounce: 'Elastic Email bounce/delivery failure%',
              });
          }));
      }))
      .orderBy('email.id', 'ASC')
      .take(limit)
      .getMany();

    const result = {
      dryRun,
      scanned: rows.length,
      candidates: 0,
      saved: 0,
      skippedNoSuggestion: 0,
      rows: [] as BounceRecoveryCandidatePreview[],
    };

    for (const row of rows) {
      const preview = await this.createCandidateFromBounce(
        row.email,
        {
          bouncedAt: row.gmailMessageDate || row.lastGmailScanDate || row.updatedAt,
          source: row.lastValidationSource === ExternalValidationProvider.ELASTIC_EMAIL
            ? 'elastic_email_bounce_backfill'
            : 'gmail_bounce_backfill',
          firstName: row.firstName,
          lastName: row.lastName,
          fullName: row.fullName,
        },
        { dryRun },
      );

      if (!preview) {
        result.skippedNoSuggestion++;
        continue;
      }

      result.candidates++;
      if (!dryRun) {
        result.saved++;
      }
      result.rows.push(preview);
    }

    return result;
  }

  async getSummary() {
    const [statusRows, reasonRows] = await Promise.all([
      this.bounceRecoveryRepository
        .createQueryBuilder('candidate')
        .select('candidate.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('candidate.status')
        .getRawMany(),
      this.bounceRecoveryRepository
        .createQueryBuilder('candidate')
        .select('candidate.reason', 'reason')
        .addSelect('COUNT(*)', 'count')
        .where('candidate.status = :status', { status: BounceRecoveryStatus.PENDING })
        .groupBy('candidate.reason')
        .getRawMany(),
    ]);

    return {
      byStatus: statusRows.reduce((acc, row) => {
        acc[row.status || 'unknown'] = Number(row.count || 0);
        return acc;
      }, {} as Record<string, number>),
      pendingByReason: reasonRows.reduce((acc, row) => {
        acc[row.reason || 'unknown'] = Number(row.count || 0);
        return acc;
      }, {} as Record<string, number>),
    };
  }

  async listCandidates(options: {
    status?: BounceRecoveryStatus;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 250);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const status = Object.values(BounceRecoveryStatus).includes(options.status as BounceRecoveryStatus)
      ? options.status
      : BounceRecoveryStatus.PENDING;

    const query = this.bounceRecoveryRepository
      .createQueryBuilder('candidate')
      .leftJoinAndSelect('candidate.email', 'email')
      .leftJoinAndSelect('candidate.customer', 'customer')
      .where('candidate.status = :status', { status })
      .orderBy('candidate.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    if (options.search?.trim()) {
      const search = `%${options.search.trim().toLowerCase()}%`;
      query.andWhere(new Brackets((qb) => {
        qb.where('LOWER(candidate.bouncedEmail) LIKE :search', { search })
          .orWhere('LOWER(candidate.suggestedEmail) LIKE :search', { search })
          .orWhere('LOWER(customer.first_name) LIKE :search', { search })
          .orWhere('LOWER(customer.last_name) LIKE :search', { search });
      }));
    }

    const [items, total] = await query.getManyAndCount();

    return {
      total,
      limit,
      offset,
      items: items.map((candidate) => ({
        id: candidate.id,
        bouncedEmail: candidate.bouncedEmail,
        suggestedEmail: candidate.suggestedEmail,
        reason: candidate.reason,
        confidence: candidate.confidence,
        status: candidate.status,
        source: candidate.source,
        bouncedAt: candidate.bouncedAt,
        createdAt: candidate.createdAt,
        emailId: candidate.emailId,
        customerId: candidate.customerId,
        customerName: candidate.customer
          ? [candidate.customer.first_name, candidate.customer.last_name].filter(Boolean).join(' ') || null
          : null,
        currentEmailStatus: candidate.email?.verificationStatus || null,
        existingSuggestedStatus: candidate.metadata?.existingSuggestedStatus || null,
      })),
    };
  }

  async approveCandidate(id: number, note?: string) {
    const candidate = await this.bounceRecoveryRepository.findOne({
      where: { id, status: BounceRecoveryStatus.PENDING },
      relations: ['customer'],
    });

    if (!candidate) {
      return {
        approved: false,
        reason: 'Candidate not found or already resolved',
      };
    }

    const suggestedEmail = this.normalizeEmail(candidate.suggestedEmail);
    if (!suggestedEmail) {
      return {
        approved: false,
        reason: 'Suggested email is empty',
      };
    }

    const existing = await this.emailRepository.findOne({ where: { email: suggestedEmail } });
    const protectedStatus = existing
      ? [
          VerificationStatus.INVALID,
          VerificationStatus.DISPOSABLE,
          VerificationStatus.UNSUBSCRIBED,
        ].includes(existing.verificationStatus)
      : false;

    let emailRecord = existing;
    if (!protectedStatus) {
      const emailDomain = suggestedEmail.split('@')[1] || null;
      const updateData = {
        email: suggestedEmail,
        emailDomain,
        customerId: candidate.customerId || existing?.customerId || null,
        firstName: existing?.firstName || candidate.customer?.first_name || candidate.metadata?.firstName || null,
        lastName: existing?.lastName || candidate.customer?.last_name || candidate.metadata?.lastName || null,
        fullName: existing?.fullName || candidate.metadata?.fullName || null,
        acquisitionSource: existing?.acquisitionSource || 'bounce_recovery',
        acquisitionDate: existing?.acquisitionDate || new Date(),
        verificationStatus: VerificationStatus.PENDING,
        qualityScore: 50,
        hasTypo: true,
        typoSuggestion: candidate.bouncedEmail,
        typoResolutionStatus: 'accepted' as const,
        typoResolvedEmail: suggestedEmail,
        typoResolvedAt: new Date(),
        typoResolutionNote: `Bounce recovery approved (${candidate.reason}); external validation required before marketing sends`,
        smtpErrorMessage: 'Bounce recovery approved; external validation required before marketing sends',
        gmailCategory: existing?.gmailCategory || null,
        ...this.sendEligibilityService.buildUpdate({
          verificationStatus: VerificationStatus.PENDING,
          qualityScore: 50,
          hasTypo: true,
          typoResolutionStatus: 'accepted',
          gmailCategory: existing?.gmailCategory,
        }, ExternalValidationProvider.INTERNAL),
      };

      if (existing) {
        await this.emailRepository.update(existing.id, updateData);
        emailRecord = await this.emailRepository.findOne({ where: { id: existing.id } });
      } else {
        emailRecord = await this.emailRepository.save(this.emailRepository.create(updateData));
      }

      await this.verificationQueue.add(
        'verify-email',
        {
          email: suggestedEmail,
          skipSmtp: false,
        },
        {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        },
      );
    }

    await this.bounceRecoveryRepository.update(candidate.id, {
      status: BounceRecoveryStatus.APPROVED,
      note: note || null,
      resolvedAt: new Date(),
      metadata: {
        ...(candidate.metadata || {}),
        approvedEmailId: emailRecord?.id || null,
        protectedSuggestedStatus: protectedStatus ? existing?.verificationStatus : null,
        validationQueued: !protectedStatus,
      },
    });

    return {
      approved: true,
      suggestedEmail,
      emailId: emailRecord?.id || null,
      validationQueued: !protectedStatus,
      protectedSuggestedStatus: protectedStatus ? existing?.verificationStatus : null,
    };
  }

  async updateSuggestion(id: number, suggestedEmail: string, note?: string) {
    const candidate = await this.bounceRecoveryRepository.findOne({
      where: { id, status: BounceRecoveryStatus.PENDING },
    });

    if (!candidate) {
      return {
        updated: false,
        reason: 'Candidate not found or already resolved',
      };
    }

    const normalizedSuggestion = this.normalizeEmail(suggestedEmail);
    if (!normalizedSuggestion || !validateEmail(normalizedSuggestion)) {
      return {
        updated: false,
        reason: 'Suggested email is not valid',
      };
    }

    if (normalizedSuggestion === this.normalizeEmail(candidate.bouncedEmail)) {
      return {
        updated: false,
        reason: 'Suggested email must be different from bounced email',
      };
    }

    const duplicate = await this.bounceRecoveryRepository.findOne({
      where: {
        bouncedEmail: candidate.bouncedEmail,
        suggestedEmail: normalizedSuggestion,
        status: BounceRecoveryStatus.PENDING,
      },
    });

    if (duplicate && Number(duplicate.id) !== Number(candidate.id)) {
      return {
        updated: false,
        reason: `Suggestion already exists on candidate #${duplicate.id}`,
      };
    }

    const previousSuggestions = Array.isArray(candidate.metadata?.previousSuggestions)
      ? candidate.metadata.previousSuggestions
      : [];
    const existingSuggested = await this.emailRepository.findOne({
      where: { email: normalizedSuggestion },
    });

    await this.bounceRecoveryRepository.update(candidate.id, {
      suggestedEmail: normalizedSuggestion,
      note: note || candidate.note || null,
      metadata: {
        ...(candidate.metadata || {}),
        existingSuggestedStatus: existingSuggested?.verificationStatus || null,
        manuallyEditedSuggestion: true,
        previousSuggestions: [
          ...previousSuggestions,
          {
            suggestedEmail: candidate.suggestedEmail,
            editedAt: new Date().toISOString(),
          },
        ],
      },
    });

    return {
      updated: true,
      id: candidate.id,
      suggestedEmail: normalizedSuggestion,
      existingSuggestedStatus: existingSuggested?.verificationStatus || null,
    };
  }

  async ignoreCandidate(id: number, note?: string) {
    const candidate = await this.bounceRecoveryRepository.findOne({
      where: { id, status: BounceRecoveryStatus.PENDING },
    });

    if (!candidate) {
      return {
        ignored: false,
        reason: 'Candidate not found or already resolved',
      };
    }

    const suggestedEmail = this.normalizeEmail(candidate.suggestedEmail);
    let suppressedEmailId: number | null = null;
    let suppressedAlready = false;

    if (suggestedEmail) {
      const existing = await this.emailRepository.findOne({ where: { email: suggestedEmail } });
      suppressedAlready = existing?.sendEligibility === SendEligibility.DO_NOT_SEND;

      if (existing) {
        suppressedEmailId = existing.id;

        if (!suppressedAlready) {
          await this.emailRepository.update(existing.id, {
            sendEligibility: SendEligibility.DO_NOT_SEND,
            doNotSendReason: 'bounce_recovery_ignored',
            lastValidationSource: ExternalValidationProvider.MANUAL,
            lastValidationAt: new Date(),
            smtpErrorMessage: 'Bounce recovery suggestion ignored; excluded from marketing sends',
          });
        }
      } else {
        const emailDomain = suggestedEmail.split('@')[1] || null;
        const created = await this.emailRepository.save(
          this.emailRepository.create({
            email: suggestedEmail,
            emailDomain,
            customerId: candidate.customerId || null,
            acquisitionSource: 'bounce_recovery_ignored',
            acquisitionDate: new Date(),
            verificationStatus: VerificationStatus.RISKY,
            qualityScore: 0,
            sendEligibility: SendEligibility.DO_NOT_SEND,
            doNotSendReason: 'bounce_recovery_ignored',
            lastValidationSource: ExternalValidationProvider.MANUAL,
            lastValidationAt: new Date(),
            smtpErrorMessage: 'Bounce recovery suggestion ignored; excluded from marketing sends',
          }),
        );
        suppressedEmailId = created.id;
      }
    }

    await this.bounceRecoveryRepository.update(candidate.id, {
      status: BounceRecoveryStatus.IGNORED,
      note: note || null,
      resolvedAt: new Date(),
      metadata: {
        ...(candidate.metadata || {}),
        suppressedEmailId,
        suppressedAlready,
        suppressionReason: 'bounce_recovery_ignored',
      },
    });

    return {
      ignored: true,
      id: candidate.id,
      suggestedEmail,
      suppressedEmailId,
      suppressedAlready,
    };
  }

  private async buildCandidatePreview(
    bouncedEmail: string,
    context: BounceRecoveryCreateContext,
  ): Promise<BounceRecoveryCandidatePreview | null> {
    const normalizedEmail = this.normalizeEmail(bouncedEmail);
    if (!normalizedEmail) {
      return null;
    }

    const [emailRecord, customerByEmail] = await Promise.all([
      this.emailRepository.findOne({ where: { email: normalizedEmail } }),
      this.customerRepository.findOne({ where: { email: normalizedEmail } }),
    ]);

    const customer = emailRecord?.customerId
      ? await this.customerRepository.findOne({ where: { id: emailRecord.customerId } })
      : customerByEmail;

    const domainResult = this.filterValidator.validate(normalizedEmail);
    let suggestedEmail = domainResult.suggestedEmail;
    let reason = BounceRecoveryReason.DOMAIN_TYPO;
    let confidence: 'high' | 'medium' = 'high';

    if (!suggestedEmail) {
      if (!isPublicMailboxDomain(extractEmailDomain(normalizedEmail))) {
        return null;
      }

      const nameSuggestion = this.filterValidator.suggestNameLocalPartCorrection(normalizedEmail, {
        firstName: context.firstName || emailRecord?.firstName || customer?.first_name,
        lastName: context.lastName || emailRecord?.lastName || customer?.last_name,
        fullName: context.fullName || emailRecord?.fullName,
      });

      if (!nameSuggestion) {
        return null;
      }

      suggestedEmail = nameSuggestion.suggestedEmail;
      reason = BounceRecoveryReason.NAME_LOCALPART_TYPO;
      confidence = nameSuggestion.confidence;
    }

    const normalizedSuggestion = this.normalizeEmail(suggestedEmail);
    if (!normalizedSuggestion || normalizedSuggestion === normalizedEmail) {
      return null;
    }

    if (!isPublicMailboxDomain(extractEmailDomain(normalizedSuggestion))) {
      return null;
    }

    const existingSuggestedEmail = await this.emailRepository.findOne({
      where: { email: normalizedSuggestion },
      select: ['id', 'email', 'verificationStatus'],
    });

    return {
      bouncedEmail: normalizedEmail,
      suggestedEmail: normalizedSuggestion,
      reason,
      confidence,
      emailId: emailRecord?.id || null,
      customerId: customer?.id || emailRecord?.customerId || null,
      existingSuggestedStatus: existingSuggestedEmail?.verificationStatus || null,
    };
  }

  private normalizeEmail(email: string | null | undefined): string {
    return String(email || '').trim().toLowerCase();
  }
}
