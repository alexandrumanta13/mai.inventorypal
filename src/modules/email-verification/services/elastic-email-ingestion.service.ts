import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';
import { extractEmailDomain } from '@shared/email-domain-classification';
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
import { BounceRecoveryService } from './bounce-recovery.service';

type ElasticEmailDisposition = 'positive' | 'negative' | 'neutral';

export interface ElasticEmailEventInput {
  email: string;
  status: string;
  subStatus?: string | null;
  reasonMessage?: string | null;
  messageCategory?: string | null;
  eventDate?: Date | null;
  messageId?: string | null;
  transactionId?: string | null;
  raw: any;
}

export interface ElasticEmailIngestionResult {
  dryRun: boolean;
  received: number;
  processed: number;
  matchedEmailRows: number;
  missingEmailRows: number;
  suppressionRowsCreated: number;
  bounceRecoveryCandidatesPreviewed: number;
  bounceRecoveryCandidatesCreated: number;
  updated: number;
  skippedDuplicateEvents: number;
  skippedUnmappedEvents: number;
  byMappedStatus: Record<string, number>;
  rows: Array<{
    email: string;
    status: string;
    mappedStatus: EmailValidationMappedStatus;
    emailId: number | null;
    action: string;
    previousStatus?: VerificationStatus | null;
    nextStatus?: VerificationStatus | null;
    doNotSendReason?: string | null;
    bounceRecoverySuggestedEmail?: string | null;
    bounceRecoveryAction?: string | null;
  }>;
}

export interface SuppressionOverview {
  totals: {
    doNotSend: number;
    elasticSuppressionRows: number;
    elasticDoNotSendRows: number;
    bounceAfterUnsubscribe: number;
    gmailBounces: number;
    gmailUnsubscribes: number;
    gmailAbuse: number;
    elasticEvents: number;
  };
  doNotSendByReason: Record<string, number>;
  doNotSendBySource: Record<string, number>;
  elasticEventsByStatus: Record<string, number>;
  elasticEventsByReason: Record<string, number>;
  gmailByCategory: Record<string, number>;
}

@Injectable()
export class ElasticEmailIngestionService {
  private readonly logger = new Logger(ElasticEmailIngestionService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(EmailValidationBatch)
    private readonly batchRepository: Repository<EmailValidationBatch>,
    @InjectRepository(EmailValidationEvent)
    private readonly eventRepository: Repository<EmailValidationEvent>,
    private readonly sendEligibilityService: SendEligibilityService,
    private readonly configService: ConfigService,
    private readonly bounceRecoveryService: BounceRecoveryService,
  ) {}

  async ingestPayload(
    payload: any,
    options: {
      dryRun?: boolean;
      sourceSegment?: EmailValidationSourceSegment;
      batchName?: string;
    } = {},
  ): Promise<ElasticEmailIngestionResult> {
    const dryRun = options.dryRun === true;
    const events = this.normalizePayload(payload);
    const result = this.createEmptyResult(dryRun, events.length);
    const batch = dryRun
      ? null
      : await this.batchRepository.save(
          this.batchRepository.create({
            provider: ExternalValidationProvider.ELASTIC_EMAIL,
            status: EmailValidationBatchStatus.COMPLETED,
            sourceSegment: options.sourceSegment || EmailValidationSourceSegment.UNKNOWN,
            name: options.batchName || 'Elastic Email event ingestion',
            totalRecords: events.length,
            submittedRecords: events.length,
            submittedAt: new Date(),
            completedAt: new Date(),
            metadata: {
              source: 'elastic_email',
            },
          }),
        );

    for (const event of events) {
      await this.ingestEvent(event, result, dryRun, batch?.id || null);
    }

    if (batch && !dryRun) {
      await this.batchRepository.update(batch.id, {
        processedRecords: result.processed,
        validCount: result.byMappedStatus[EmailValidationMappedStatus.VALID] || 0,
        invalidCount: result.byMappedStatus[EmailValidationMappedStatus.INVALID] || 0,
        riskyCount: result.byMappedStatus[EmailValidationMappedStatus.RISKY] || 0,
        unknownCount: result.byMappedStatus[EmailValidationMappedStatus.UNKNOWN] || 0,
      });
    }

    return result;
  }

  async pullLegacyEvents(options: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    status?: string;
    dryRun?: boolean;
  } = {}): Promise<ElasticEmailIngestionResult & { fetched: number; endpoint: string }> {
    const apiKey = this.configService.get<string>('ELASTIC_EMAIL_API_KEY');
    if (!apiKey) {
      throw new Error('ELASTIC_EMAIL_API_KEY is not configured');
    }

    const requestedEventTypes = this.normalizeElasticEventTypes(options.status);
    const events: any[] = [];
    const seen = new Set<string>();
    const eventTypesToFetch = requestedEventTypes.length ? requestedEventTypes : [null];

    for (const eventType of eventTypesToFetch) {
      const url = this.buildElasticEventsUrl(options, eventType);
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-ElasticEmail-ApiKey': apiKey,
        },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || body?.message || `Elastic Email events request failed with HTTP ${response.status}`);
      }

      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      for (const row of rows) {
        const dedupeKey = this.buildElasticEventDedupeKey(row);
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        events.push(row);
      }
    }

    const result = await this.ingestPayload(events, {
      dryRun: options.dryRun !== false,
      sourceSegment: EmailValidationSourceSegment.MANUAL,
      batchName: 'Elastic Email event pull',
    });

    return {
      ...result,
      fetched: events.length,
      endpoint: 'https://api.elasticemail.com/v4/events',
    };
  }

  private buildElasticEventsUrl(
    options: {
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    },
    eventType: string | null,
  ): URL {
    const url = new URL('https://api.elasticemail.com/v4/events');
    url.searchParams.set('limit', String(Math.min(Math.max(Number(options.limit) || 1000, 1), 10000)));
    url.searchParams.set('offset', String(Math.max(Number(options.offset) || 0, 0)));
    if (options.from) {
      url.searchParams.set('from', options.from);
    }
    if (options.to) {
      url.searchParams.set('to', options.to);
    }
    if (eventType) {
      url.searchParams.set('eventTypes', eventType);
    }
    return url;
  }

  private normalizeElasticEventTypes(status?: string): string[] {
    if (!status) {
      return [];
    }

    const aliases: Record<string, string> = {
      abuse: 'Complaint',
      bounce: 'Bounce',
      bounced: 'Bounce',
      click: 'Click',
      clicked: 'Click',
      complaint: 'Complaint',
      delivered: 'Sent',
      deliveryerror: 'Bounce',
      error: 'Bounce',
      failed: 'Bounce',
      failedattempt: 'FailedAttempt',
      open: 'Open',
      opened: 'Open',
      sent: 'Sent',
      spam: 'Complaint',
      submission: 'Submission',
      suppressed: 'Bounce',
      unsubscribe: 'Unsubscribe',
      unsubscribed: 'Unsubscribe',
    };

    return [
      ...new Set(
        status
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => aliases[item.toLowerCase().replace(/[^a-z]/g, '')] || item),
      ),
    ];
  }

  private buildElasticEventDedupeKey(row: any): string {
    return [
      this.firstString(row, ['TransactionID', 'transactionId', 'transactionid']),
      this.firstString(row, ['MsgID', 'messageId', 'MessageID', 'messageid']),
      this.firstString(row, ['EventType', 'eventType', 'status', 'Status']),
      this.firstString(row, ['To', 'to', 'Email', 'email']),
      this.firstString(row, ['EventDate', 'eventDate', 'date', 'Date']),
    ]
      .filter(Boolean)
      .join('|');
  }

  verifyWebhookSecret(providedSecret?: string | string[] | null): boolean {
    const expectedSecret = this.configService.get<string>('ELASTIC_EMAIL_WEBHOOK_SECRET');
    if (!expectedSecret) {
      return false;
    }

    const normalizedSecret = Array.isArray(providedSecret) ? providedSecret[0] : providedSecret;
    return normalizedSecret === expectedSecret;
  }

  async getSuppressionOverview(): Promise<SuppressionOverview> {
    const [
      doNotSendTotal,
      elasticSuppressionRows,
      elasticDoNotSendRows,
      bounceAfterUnsubscribe,
      reasonRows,
      sourceRows,
      elasticStatusRows,
      elasticReasonRows,
      gmailRows,
    ] = await Promise.all([
      this.emailRepository.count({
        where: { sendEligibility: SendEligibility.DO_NOT_SEND },
      }),
      this.emailRepository.count({
        where: { acquisitionSource: 'elastic_email_suppression' },
      }),
      this.emailRepository.count({
        where: {
          sendEligibility: SendEligibility.DO_NOT_SEND,
          lastValidationSource: ExternalValidationProvider.ELASTIC_EMAIL,
        },
      }),
      this.emailRepository.count({
        where: { doNotSendReason: 'bounce_after_unsubscribe' },
      }),
      this.emailRepository
        .createQueryBuilder('email')
        .select("COALESCE(email.doNotSendReason, 'unknown')", 'reason')
        .addSelect('COUNT(*)', 'count')
        .where('email.sendEligibility = :eligibility', { eligibility: SendEligibility.DO_NOT_SEND })
        .groupBy("COALESCE(email.doNotSendReason, 'unknown')")
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany(),
      this.emailRepository
        .createQueryBuilder('email')
        .select("COALESCE(email.lastValidationSource, 'unknown')", 'source')
        .addSelect('COUNT(*)', 'count')
        .where('email.sendEligibility = :eligibility', { eligibility: SendEligibility.DO_NOT_SEND })
        .groupBy("COALESCE(email.lastValidationSource, 'unknown')")
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany(),
      this.eventRepository
        .createQueryBuilder('event')
        .select('event.mappedStatus', 'status')
        .addSelect('COUNT(*)', 'count')
        .where('event.provider = :provider', { provider: ExternalValidationProvider.ELASTIC_EMAIL })
        .groupBy('event.mappedStatus')
        .getRawMany(),
      this.eventRepository
        .createQueryBuilder('event')
        .select("COALESCE(event.reasonCode, 'unknown')", 'reason')
        .addSelect('COUNT(*)', 'count')
        .where('event.provider = :provider', { provider: ExternalValidationProvider.ELASTIC_EMAIL })
        .groupBy("COALESCE(event.reasonCode, 'unknown')")
        .orderBy('COUNT(*)', 'DESC')
        .getRawMany(),
      this.emailRepository
        .createQueryBuilder('email')
        .select('email.gmailCategory', 'category')
        .addSelect('COUNT(*)', 'count')
        .where('email.gmailCategory IN (:...categories)', {
          categories: ['bounce', 'unsubscribe', 'abuse'],
        })
        .groupBy('email.gmailCategory')
        .getRawMany(),
    ]);

    const gmailByCategory = this.rowsToMap(gmailRows, 'category');
    const elasticEventsByStatus = this.rowsToMap(elasticStatusRows, 'status');

    return {
      totals: {
        doNotSend: doNotSendTotal,
        elasticSuppressionRows,
        elasticDoNotSendRows,
        bounceAfterUnsubscribe,
        gmailBounces: Number(gmailByCategory.bounce || 0),
        gmailUnsubscribes: Number(gmailByCategory.unsubscribe || 0),
        gmailAbuse: Number(gmailByCategory.abuse || 0),
        elasticEvents: Object.values(elasticEventsByStatus).reduce((sum, count) => sum + count, 0),
      },
      doNotSendByReason: this.rowsToMap(reasonRows, 'reason'),
      doNotSendBySource: this.rowsToMap(sourceRows, 'source'),
      elasticEventsByStatus,
      elasticEventsByReason: this.rowsToMap(elasticReasonRows, 'reason'),
      gmailByCategory,
    };
  }

  private async ingestEvent(
    event: ElasticEmailEventInput,
    result: ElasticEmailIngestionResult,
    dryRun: boolean,
    batchId: number | null,
  ): Promise<void> {
    const normalizedEmail = event.email.trim().toLowerCase();
    const mapping = this.mapProviderStatus(event.status, event.subStatus, event.reasonMessage);
    result.byMappedStatus[mapping.mappedStatus] = (result.byMappedStatus[mapping.mappedStatus] || 0) + 1;

    if (mapping.disposition === 'neutral') {
      result.skippedUnmappedEvents++;
      result.rows.push({
        email: normalizedEmail,
        status: event.status,
        mappedStatus: mapping.mappedStatus,
        emailId: null,
        action: 'stored_event_only',
      });
      if (!dryRun) {
        await this.saveEvent(event, normalizedEmail, null, batchId, mapping, SendEligibility.PENDING, null);
      }
      return;
    }

    const emailRecord = await this.emailRepository.findOne({
      where: { email: normalizedEmail },
    });

    if (!emailRecord) {
      result.missingEmailRows++;
      const shouldCreateSuppression = mapping.disposition === 'negative';
      let createdSuppression: Email | null = null;
      const bounceRecovery = await this.maybeCreateBounceRecoveryCandidate(
        event,
        normalizedEmail,
        null,
        mapping,
        dryRun,
        result,
      );

      result.rows.push({
        email: normalizedEmail,
        status: event.status,
        mappedStatus: mapping.mappedStatus,
        emailId: null,
        action: shouldCreateSuppression
          ? dryRun
            ? 'would_create_do_not_send_suppression'
            : 'created_do_not_send_suppression'
          : 'stored_event_missing_email_row',
        nextStatus: shouldCreateSuppression
          ? this.mapSuppressionVerificationStatus(mapping.mappedStatus)
          : null,
        doNotSendReason: shouldCreateSuppression ? mapping.reasonCode : null,
        bounceRecoverySuggestedEmail: bounceRecovery?.suggestedEmail || null,
        bounceRecoveryAction: bounceRecovery
          ? dryRun
            ? 'would_create_bounce_recovery_candidate'
            : 'created_bounce_recovery_candidate'
          : null,
      });

      if (!dryRun) {
        if (shouldCreateSuppression) {
          createdSuppression = await this.createSuppressionEmail(event, normalizedEmail, mapping);
          result.suppressionRowsCreated++;
        }

        await this.saveEvent(
          event,
          normalizedEmail,
          createdSuppression?.id || null,
          batchId,
          mapping,
          mapping.sendEligibility,
          mapping.reasonCode,
        );
      }
      result.processed++;
      return;
    }

    result.matchedEmailRows++;

    const duplicate = await this.findDuplicateEvent(event, normalizedEmail, emailRecord.id);
    if (duplicate) {
      result.skippedDuplicateEvents++;
      result.rows.push({
        email: normalizedEmail,
        status: event.status,
        mappedStatus: mapping.mappedStatus,
        emailId: emailRecord.id,
        action: 'duplicate_event_skipped',
      });
      return;
    }

    const update = this.buildEmailUpdate(emailRecord, event, mapping);
    const bounceRecovery = await this.maybeCreateBounceRecoveryCandidate(
      event,
      normalizedEmail,
      emailRecord,
      mapping,
      dryRun,
      result,
    );
    result.rows.push({
      email: normalizedEmail,
      status: event.status,
      mappedStatus: mapping.mappedStatus,
      emailId: emailRecord.id,
      action: update ? 'updated_email_status' : 'stored_event_protected_email',
      previousStatus: emailRecord.verificationStatus,
      nextStatus: update?.verificationStatus || emailRecord.verificationStatus,
      doNotSendReason: update?.doNotSendReason || emailRecord.doNotSendReason,
      bounceRecoverySuggestedEmail: bounceRecovery?.suggestedEmail || null,
      bounceRecoveryAction: bounceRecovery
        ? dryRun
          ? 'would_create_bounce_recovery_candidate'
          : 'created_bounce_recovery_candidate'
        : null,
    });

    if (!dryRun) {
      await this.saveEvent(
        event,
        normalizedEmail,
        emailRecord.id,
        batchId,
        mapping,
        update?.sendEligibility || emailRecord.sendEligibility || mapping.sendEligibility,
        update?.doNotSendReason || emailRecord.doNotSendReason || mapping.reasonCode,
      );

      if (update) {
        await this.emailRepository.update(emailRecord.id, update);
        result.updated++;
      }
    }

    result.processed++;
  }

  private async maybeCreateBounceRecoveryCandidate(
    event: ElasticEmailEventInput,
    normalizedEmail: string,
    emailRecord: Email | null,
    mapping: ReturnType<ElasticEmailIngestionService['mapProviderStatus']>,
    dryRun: boolean,
    result: ElasticEmailIngestionResult,
  ) {
    if (mapping.mappedStatus !== EmailValidationMappedStatus.INVALID || mapping.disposition !== 'negative') {
      return null;
    }

    const preview = await this.bounceRecoveryService.createCandidateFromBounce(
      normalizedEmail,
      {
        bouncedAt: event.eventDate || new Date(),
        source: 'elastic_email_bounce',
        messageId: event.messageId || event.transactionId || null,
        subject: this.firstString(event.raw || {}, ['Subject', 'subject']),
        from: this.firstString(event.raw || {}, ['FromEmail', 'from', 'From']),
        firstName: emailRecord?.firstName || null,
        lastName: emailRecord?.lastName || null,
        fullName: emailRecord?.fullName || null,
      },
      { dryRun },
    );

    if (!preview) {
      return null;
    }

    if (dryRun) {
      result.bounceRecoveryCandidatesPreviewed++;
    } else {
      result.bounceRecoveryCandidatesCreated++;
    }
    return preview;
  }

  private buildEmailUpdate(
    emailRecord: Email,
    event: ElasticEmailEventInput,
    mapping: ReturnType<ElasticEmailIngestionService['mapProviderStatus']>,
  ): Partial<Email> | null {
    const now = new Date();

    if (mapping.mappedStatus === EmailValidationMappedStatus.INVALID) {
      const nextStatus = VerificationStatus.INVALID;
      const eligibilityUpdate = this.sendEligibilityService.buildUpdate(
        {
          verificationStatus: nextStatus,
          previousVerificationStatus: emailRecord.verificationStatus,
          gmailCategory: emailRecord.gmailCategory,
        },
        ExternalValidationProvider.ELASTIC_EMAIL,
      );

      return {
        verificationStatus: nextStatus,
        qualityScore: 0,
        hasValidSmtp: false,
        smtpResultCode: event.status,
        smtpErrorMessage: this.buildSmtpErrorMessage(event, 'Elastic Email bounce/delivery failure'),
        ...eligibilityUpdate,
        doNotSendReason:
          eligibilityUpdate.doNotSendReason === 'bounce_after_unsubscribe'
            ? eligibilityUpdate.doNotSendReason
            : mapping.reasonCode,
        lastVerifiedAt: now,
      };
    }

    if (mapping.mappedStatus === EmailValidationMappedStatus.RISKY) {
      return {
        verificationStatus: VerificationStatus.RISKY,
        qualityScore: Math.min(Number(emailRecord.qualityScore || 45), 45),
        hasValidSmtp: false,
        smtpResultCode: event.status,
        smtpErrorMessage: this.buildSmtpErrorMessage(event, 'Elastic Email soft/transient bounce'),
        sendEligibility: SendEligibility.REVIEW,
        doNotSendReason: mapping.reasonCode,
        lastValidationSource: ExternalValidationProvider.ELASTIC_EMAIL,
        lastValidationAt: now,
        lastVerifiedAt: now,
      };
    }

    if (mapping.mappedStatus === EmailValidationMappedStatus.DO_NOT_MAIL) {
      const nextStatus = VerificationStatus.UNSUBSCRIBED;
      return {
        verificationStatus: nextStatus,
        smtpResultCode: event.status,
        smtpErrorMessage: this.buildSmtpErrorMessage(event, 'Elastic Email unsubscribe event'),
        ...this.sendEligibilityService.buildUpdate(
          {
            verificationStatus: nextStatus,
            previousVerificationStatus: emailRecord.verificationStatus,
          },
          ExternalValidationProvider.ELASTIC_EMAIL,
        ),
        lastVerifiedAt: now,
      };
    }

    if (mapping.mappedStatus === EmailValidationMappedStatus.ABUSE) {
      return {
        verificationStatus: VerificationStatus.RISKY,
        qualityScore: 0,
        gmailCategory: emailRecord.gmailCategory || 'abuse',
        smtpResultCode: event.status,
        smtpErrorMessage: this.buildSmtpErrorMessage(event, 'Elastic Email abuse/complaint event'),
        sendEligibility: SendEligibility.DO_NOT_SEND,
        doNotSendReason: 'elastic_abuse_complaint',
        lastValidationSource: ExternalValidationProvider.ELASTIC_EMAIL,
        lastValidationAt: now,
        lastVerifiedAt: now,
      };
    }

    if (mapping.mappedStatus === EmailValidationMappedStatus.VALID) {
      if (this.isProtectedFromPromotion(emailRecord)) {
        return null;
      }

      const nextStatus = VerificationStatus.VALID;
      return {
        verificationStatus: nextStatus,
        qualityScore: Math.max(Number(emailRecord.qualityScore || 0), 80),
        hasValidSmtp: true,
        smtpResultCode: event.status,
        smtpErrorMessage: this.buildSmtpErrorMessage(event, 'Elastic Email delivery confirmed'),
        ...this.sendEligibilityService.buildUpdate(
          {
            verificationStatus: nextStatus,
            qualityScore: Math.max(Number(emailRecord.qualityScore || 0), 80),
            gmailCategory: emailRecord.gmailCategory,
            hasTypo: emailRecord.hasTypo,
            typoResolutionStatus: emailRecord.typoResolutionStatus,
            isDisposable: emailRecord.isDisposable,
            isRoleBased: emailRecord.isRoleBased,
          },
          ExternalValidationProvider.ELASTIC_EMAIL,
        ),
        lastVerifiedAt: now,
      };
    }

    return null;
  }

  private isProtectedFromPromotion(emailRecord: Email): boolean {
    return [
      VerificationStatus.INVALID,
      VerificationStatus.UNSUBSCRIBED,
      VerificationStatus.DISPOSABLE,
    ].includes(emailRecord.verificationStatus)
      || emailRecord.sendEligibility === SendEligibility.DO_NOT_SEND
      || emailRecord.hasTypo === true;
  }

  private async createSuppressionEmail(
    event: ElasticEmailEventInput,
    normalizedEmail: string,
    mapping: ReturnType<ElasticEmailIngestionService['mapProviderStatus']>,
  ): Promise<Email> {
    const now = new Date();
    const verificationStatus = this.mapSuppressionVerificationStatus(mapping.mappedStatus);

    return this.emailRepository.save(
      this.emailRepository.create({
        email: normalizedEmail,
        emailDomain: extractEmailDomain(normalizedEmail),
        acquisitionSource: 'elastic_email_suppression',
        acquisitionDate: event.eventDate || now,
        gmailCategory: this.mapSuppressionGmailCategory(mapping.mappedStatus),
        verificationStatus,
        qualityScore: 0,
        hasValidSmtp: mapping.mappedStatus === EmailValidationMappedStatus.INVALID ? false : null,
        smtpResultCode: event.status,
        smtpErrorMessage: this.buildSmtpErrorMessage(event, 'Elastic Email suppression event'),
        sendEligibility: mapping.sendEligibility,
        doNotSendReason: mapping.reasonCode,
        lastValidationSource: ExternalValidationProvider.ELASTIC_EMAIL,
        lastValidationAt: now,
        lastVerifiedAt: now,
      }),
    );
  }

  private mapSuppressionVerificationStatus(mappedStatus: EmailValidationMappedStatus): VerificationStatus {
    if (mappedStatus === EmailValidationMappedStatus.DO_NOT_MAIL) {
      return VerificationStatus.UNSUBSCRIBED;
    }

    if (mappedStatus === EmailValidationMappedStatus.ABUSE) {
      return VerificationStatus.RISKY;
    }

    if (mappedStatus === EmailValidationMappedStatus.RISKY) {
      return VerificationStatus.RISKY;
    }

    return VerificationStatus.INVALID;
  }

  private mapSuppressionGmailCategory(
    mappedStatus: EmailValidationMappedStatus,
  ): 'unsubscribe' | 'abuse' | 'bounce' | null {
    if (mappedStatus === EmailValidationMappedStatus.DO_NOT_MAIL) {
      return 'unsubscribe';
    }

    if (mappedStatus === EmailValidationMappedStatus.ABUSE) {
      return 'abuse';
    }

    if (mappedStatus === EmailValidationMappedStatus.INVALID) {
      return 'bounce';
    }

    return null;
  }

  private async saveEvent(
    event: ElasticEmailEventInput,
    normalizedEmail: string,
    emailId: number | null,
    batchId: number | null,
    mapping: ReturnType<ElasticEmailIngestionService['mapProviderStatus']>,
    sendEligibility: SendEligibility,
    reasonCode: string | null,
  ): Promise<EmailValidationEvent> {
    return this.eventRepository.save(
      this.eventRepository.create({
        batchId,
        emailId,
        provider: ExternalValidationProvider.ELASTIC_EMAIL,
        inputEmail: event.email,
        normalizedEmail,
        providerStatus: event.status,
        providerSubStatus: event.subStatus || event.messageCategory || null,
        mappedStatus: mapping.mappedStatus,
        sendEligibility,
        reasonCode,
        confidenceScore: mapping.confidenceScore,
        rawResponse: event.raw,
        validatedAt: event.eventDate || new Date(),
      }),
    );
  }

  private async findDuplicateEvent(
    event: ElasticEmailEventInput,
    normalizedEmail: string,
    emailId: number,
  ): Promise<EmailValidationEvent | null> {
    if (!event.eventDate) {
      return null;
    }

    return this.eventRepository.findOne({
      where: {
        emailId,
        provider: ExternalValidationProvider.ELASTIC_EMAIL,
        normalizedEmail,
        providerStatus: event.status,
        validatedAt: event.eventDate,
      },
    });
  }

  private normalizePayload(payload: any): ElasticEmailEventInput[] {
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.events)
          ? payload.events
          : [payload];

    return rows
      .map((row) => this.normalizeEvent(row))
      .filter((event): event is ElasticEmailEventInput => Boolean(event));
  }

  private normalizeEvent(row: any): ElasticEmailEventInput | null {
    if (!row || typeof row !== 'object') {
      return null;
    }

    const email = this.firstString(row, [
      'email',
      'Email',
      'recipient',
      'Recipient',
      'to',
      'To',
      'msgTo',
      'MsgTo',
      'address',
      'Address',
    ]);

    if (!email || !email.includes('@')) {
      return null;
    }

    return {
      email: email.trim().toLowerCase(),
      status: this.firstString(row, [
        'status',
        'Status',
        'event',
        'Event',
        'eventType',
        'EventType',
        'EventName',
        'eventname',
        'LogEventStatus',
      ]) || 'unknown',
      subStatus: this.firstString(row, [
        'subStatus',
        'SubStatus',
        'MessageCategory',
        'messageCategory',
        'reason',
        'Reason',
        'category',
        'Category',
        'error',
        'Error',
      ]),
      reasonMessage: this.firstString(row, [
        'message',
        'Message',
        'reason',
        'Reason',
        'error',
        'Error',
        'StatusMessage',
        'statusMessage',
        'description',
        'Description',
      ]),
      messageCategory: this.firstString(row, ['MessageCategory', 'messageCategory']),
      eventDate: this.parseDate(
        this.firstString(row, [
          'date',
          'Date',
          'eventDate',
          'EventDate',
          'time',
          'Time',
          'timestamp',
          'Timestamp',
          'DateSent',
          'dateSent',
        ]),
      ),
      messageId: this.firstString(row, ['messageId', 'MessageID', 'messageid', 'MsgID']),
      transactionId: this.firstString(row, ['transactionId', 'TransactionID', 'transactionid']),
      raw: row,
    };
  }

  private mapProviderStatus(status: string, subStatus?: string | null, reasonMessage?: string | null): {
    mappedStatus: EmailValidationMappedStatus;
    disposition: ElasticEmailDisposition;
    sendEligibility: SendEligibility;
    reasonCode: string | null;
    confidenceScore: number;
  } {
    const normalized = `${status || ''} ${subStatus || ''} ${reasonMessage || ''}`.toLowerCase();

    if (/\b(error|bounce|bounced|not delivered|failed|suppressed)\b/.test(normalized) || status === '4') {
      if (this.isElasticSenderAuthFailure(normalized)) {
        return {
          mappedStatus: EmailValidationMappedStatus.RISKY,
          disposition: 'negative',
          sendEligibility: SendEligibility.REVIEW,
          reasonCode: 'elastic_delivery_auth_failure',
          confidenceScore: 60,
        };
      }

      if (this.isSoftElasticBounce(normalized)) {
        return {
          mappedStatus: EmailValidationMappedStatus.RISKY,
          disposition: 'negative',
          sendEligibility: SendEligibility.REVIEW,
          reasonCode: this.getSoftElasticBounceReasonCode(normalized),
          confidenceScore: 70,
        };
      }

      if (this.isElasticDomainOrTransportFailure(normalized)) {
        return {
          mappedStatus: EmailValidationMappedStatus.RISKY,
          disposition: 'negative',
          sendEligibility: SendEligibility.REVIEW,
          reasonCode: this.getElasticDomainOrTransportReasonCode(normalized),
          confidenceScore: 65,
        };
      }

      return {
        mappedStatus: EmailValidationMappedStatus.INVALID,
        disposition: 'negative',
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: this.getHardElasticBounceReasonCode(normalized),
        confidenceScore: 100,
      };
    }

    if (/\b(unsubscribe|unsubscribed)\b/.test(normalized) || status === '8') {
      return {
        mappedStatus: EmailValidationMappedStatus.DO_NOT_MAIL,
        disposition: 'negative',
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: 'elastic_unsubscribed',
        confidenceScore: 100,
      };
    }

    if (/\b(abuse|complaint|spam)\b/.test(normalized) || status === '9') {
      return {
        mappedStatus: EmailValidationMappedStatus.ABUSE,
        disposition: 'negative',
        sendEligibility: SendEligibility.DO_NOT_SEND,
        reasonCode: 'elastic_abuse_complaint',
        confidenceScore: 100,
      };
    }

    if (/\b(sent|delivered|opened|clicked)\b/.test(normalized) || ['5', '6', '7'].includes(status)) {
      return {
        mappedStatus: EmailValidationMappedStatus.VALID,
        disposition: 'positive',
        sendEligibility: SendEligibility.SAFE_TO_SEND,
        reasonCode: 'elastic_delivery_confirmed',
        confidenceScore: 90,
      };
    }

    return {
      mappedStatus: EmailValidationMappedStatus.UNKNOWN,
      disposition: 'neutral',
      sendEligibility: SendEligibility.PENDING,
      reasonCode: 'elastic_event_unmapped',
      confidenceScore: 50,
    };
  }

  private firstString(row: any, keys: string[]): string | null {
    for (const key of keys) {
      const value = row[key];
      if (value === undefined || value === null) {
        continue;
      }
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private isSoftElasticBounce(normalized: string): boolean {
    return [
      '4.2.',
      '4.3.',
      '4.4.',
      '4.7.',
      'temporar',
      'try again',
      'insufficient system storage',
      'out of storage',
      'over quota',
      'mailbox full',
      'quota exceeded',
      'too many',
      'rate limit',
      'greylist',
      'deferred',
    ].some((keyword) => normalized.includes(keyword));
  }

  private isElasticSenderAuthFailure(normalized: string): boolean {
    return [
      'spfproblem',
      'spf problem',
      'dkim',
      'dmarc',
      'access denied',
      'sending domain',
      "sender's domain",
      'authentication level',
      'authentication failed',
      'domain does not pass',
      'not authorized',
    ].some((keyword) => normalized.includes(keyword));
  }

  private isElasticDomainOrTransportFailure(normalized: string): boolean {
    return [
      'dnsproblem',
      'dns problem',
      'dns error',
      'no valid mx',
      'no mx',
      'timeout',
      'timed out',
      'connectionproblem',
      'connection problem',
      'connection refused',
      'connection reset',
    ].some((keyword) => normalized.includes(keyword));
  }

  private getSoftElasticBounceReasonCode(normalized: string): string {
    if (
      normalized.includes('insufficient system storage') ||
      normalized.includes('out of storage') ||
      normalized.includes('over quota') ||
      normalized.includes('mailbox full') ||
      normalized.includes('quota exceeded')
    ) {
      return 'elastic_soft_bounce_mailbox_full';
    }

    if (
      normalized.includes('rate limit') ||
      normalized.includes('too many') ||
      normalized.includes('greylist') ||
      normalized.includes('deferred')
    ) {
      return 'elastic_soft_bounce_rate_limited';
    }

    return 'elastic_soft_bounce_temporary';
  }

  private getElasticDomainOrTransportReasonCode(normalized: string): string {
    if (
      normalized.includes('dnsproblem') ||
      normalized.includes('dns problem') ||
      normalized.includes('dns error') ||
      normalized.includes('no valid mx') ||
      normalized.includes('no mx')
    ) {
      return 'elastic_domain_dns_failure';
    }

    return 'elastic_delivery_connection_failure';
  }

  private getHardElasticBounceReasonCode(normalized: string): string {
    if (
      normalized.includes('5.1.1') ||
      normalized.includes('user does not exist') ||
      normalized.includes('no such user') ||
      normalized.includes('mailbox unavailable') ||
      normalized.includes('recipient address rejected')
    ) {
      return 'elastic_hard_bounce_mailbox_not_found';
    }

    if (normalized.includes('disabled') || normalized.includes('inactive')) {
      return 'elastic_hard_bounce_account_disabled';
    }

    return 'elastic_hard_bounce';
  }

  private rowsToMap(rows: any[], keyName: string): Record<string, number> {
    return rows.reduce((acc, row) => {
      const key = String(row[keyName] || 'unknown');
      acc[key] = Number(row.count || 0);
      return acc;
    }, {} as Record<string, number>);
  }

  private parseDate(value?: string | null): Date | null {
    if (!value) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private buildSmtpErrorMessage(event: ElasticEmailEventInput, prefix: string): string {
    return [
      prefix,
      event.subStatus || event.messageCategory || null,
      event.reasonMessage || null,
      event.messageId ? `messageId=${event.messageId}` : null,
      event.transactionId ? `transactionId=${event.transactionId}` : null,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  private createEmptyResult(dryRun: boolean, received: number): ElasticEmailIngestionResult {
    return {
      dryRun,
      received,
      processed: 0,
      matchedEmailRows: 0,
      missingEmailRows: 0,
      suppressionRowsCreated: 0,
      bounceRecoveryCandidatesPreviewed: 0,
      bounceRecoveryCandidatesCreated: 0,
      updated: 0,
      skippedDuplicateEvents: 0,
      skippedUnmappedEvents: 0,
      byMappedStatus: {},
      rows: [],
    };
  }
}
