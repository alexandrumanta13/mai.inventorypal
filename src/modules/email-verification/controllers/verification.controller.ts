import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  ParseIntPipe,
  Logger,
  Headers,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import { VerificationHistory } from '../entities/verification-history.entity';
import { EmailValidationBatch } from '../entities/email-validation-batch.entity';
import { EmailVerifierService } from '../services/email-verifier.service';
import { ValidationIntakeGateService } from '../services/validation-intake-gate.service';
import { BounceRecoveryService } from '../services/bounce-recovery.service';
import { ElasticEmailIngestionService } from '../services/elastic-email-ingestion.service';
import { ExternalValidationImportService } from '../services/external-validation-import.service';
import { ZeroBounceSegment, ZeroBounceValidationService } from '../services/zerobounce-validation.service';
import { BounceRecoveryStatus } from '../entities/bounce-recovery-candidate.entity';
import { EmailValidationSourceSegment, ExternalValidationProvider } from '@shared/enums/email-validation.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { VerificationJobData } from '../processors/verification.processor';
import { TypoScanJobData } from '../processors/typo-scan.processor';
import { Public } from '@modules/auth/decorators/public.decorator';

/**
 * Verification Controller
 *
 * Provides API endpoints for email verification:
 * - Start verification jobs (batch processing)
 * - Test single email verification
 * - Get verification statistics
 * - Monitor queue status
 */
@Controller('verification')
export class VerificationController {
  private readonly logger = new Logger(VerificationController.name);

  constructor(
    @InjectQueue('email-verification')
    private readonly verificationQueue: Queue<VerificationJobData>,
    @InjectQueue('typo-scan')
    private readonly typoScanQueue: Queue<TypoScanJobData>,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(VerificationHistory)
    private readonly verificationHistoryRepository: Repository<VerificationHistory>,
    @InjectRepository(EmailValidationBatch)
    private readonly emailValidationBatchRepository: Repository<EmailValidationBatch>,
    private readonly emailVerifierService: EmailVerifierService,
    private readonly validationIntakeGateService: ValidationIntakeGateService,
    private readonly bounceRecoveryService: BounceRecoveryService,
    private readonly elasticEmailIngestionService: ElasticEmailIngestionService,
    private readonly externalValidationImportService: ExternalValidationImportService,
    private readonly zeroBounceValidationService: ZeroBounceValidationService,
  ) {}

  @Get('intake-overview')
  async getIntakeOverview(@Query('includeDomains') includeDomains?: string) {
    return {
      success: true,
      overview: await this.validationIntakeGateService.getOverview({
        includeDomains: includeDomains === 'true',
      }),
    };
  }

  @Get('bounce-recovery/summary')
  async getBounceRecoverySummary() {
    return {
      success: true,
      summary: await this.bounceRecoveryService.getSummary(),
    };
  }

  @Get('bounce-recovery')
  async listBounceRecoveryCandidates(
    @Query('status') status?: BounceRecoveryStatus,
    @Query('search') search?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return {
      success: true,
      result: await this.bounceRecoveryService.listCandidates({
        status,
        search,
        limit,
        offset,
      }),
    };
  }

  @Post('bounce-recovery/backfill')
  async backfillBounceRecovery(
    @Body('limit') limit?: number,
    @Body('dryRun') dryRun?: boolean,
  ) {
    return {
      success: true,
      result: await this.bounceRecoveryService.backfillFromExistingBounces({
        limit,
        dryRun,
      }),
    };
  }

  @Post('bounce-recovery/:id/approve')
  async approveBounceRecoveryCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body('note') note?: string,
  ) {
    return {
      success: true,
      result: await this.bounceRecoveryService.approveCandidate(id, note),
    };
  }

  @Post('bounce-recovery/:id/suggestion')
  async updateBounceRecoverySuggestion(
    @Param('id', ParseIntPipe) id: number,
    @Body('suggestedEmail') suggestedEmail: string,
    @Body('note') note?: string,
  ) {
    return {
      success: true,
      result: await this.bounceRecoveryService.updateSuggestion(id, suggestedEmail, note),
    };
  }

  @Post('bounce-recovery/:id/ignore')
  async ignoreBounceRecoveryCandidate(
    @Param('id', ParseIntPipe) id: number,
    @Body('note') note?: string,
  ) {
    return {
      success: true,
      result: await this.bounceRecoveryService.ignoreCandidate(id, note),
    };
  }

  @Public()
  @Get('elastic-email/webhook')
  async verifyElasticEmailWebhookUrl(
    @Query('secret') secret?: string,
    @Headers('x-elastic-email-secret') headerSecret?: string,
  ) {
    if (!this.elasticEmailIngestionService.verifyWebhookSecret(headerSecret || secret)) {
      throw new UnauthorizedException('Invalid Elastic Email webhook secret');
    }

    return {
      success: true,
      provider: 'elastic_email',
    };
  }

  @Public()
  @HttpCode(200)
  @Post('elastic-email/webhook')
  async ingestElasticEmailWebhook(
    @Body() payload: any,
    @Query('secret') secret?: string,
    @Headers('x-elastic-email-secret') headerSecret?: string,
  ) {
    if (!this.elasticEmailIngestionService.verifyWebhookSecret(headerSecret || secret)) {
      throw new UnauthorizedException('Invalid Elastic Email webhook secret');
    }

    return {
      success: true,
      result: await this.elasticEmailIngestionService.ingestPayload(payload, {
        dryRun: false,
        sourceSegment: EmailValidationSourceSegment.SUPPLIKIT_INTAKE,
        batchName: 'Elastic Email webhook',
      }),
    };
  }

  @Post('elastic-email/ingest')
  async ingestElasticEmailPayload(
    @Body('payload') payload: any,
    @Body('dryRun') dryRun?: boolean,
  ) {
    return {
      success: true,
      result: await this.elasticEmailIngestionService.ingestPayload(payload, {
        dryRun: dryRun !== false,
        sourceSegment: EmailValidationSourceSegment.MANUAL,
        batchName: 'Elastic Email manual ingestion',
      }),
    };
  }

  @Post('external-results/preview')
  async previewExternalValidationResults(
    @Body('provider') provider: ExternalValidationProvider,
    @Body('csv') csv: string,
    @Body('sourceSegment') sourceSegment?: EmailValidationSourceSegment,
  ) {
    return {
      success: true,
      result: await this.externalValidationImportService.importCsv({
        provider,
        csv,
        sourceSegment: sourceSegment || EmailValidationSourceSegment.UNKNOWN,
        dryRun: true,
      }),
    };
  }

  @Post('external-results/import')
  async importExternalValidationResults(
    @Body('provider') provider: ExternalValidationProvider,
    @Body('csv') csv: string,
    @Body('sourceSegment') sourceSegment?: EmailValidationSourceSegment,
    @Body('batchName') batchName?: string,
  ) {
    return {
      success: true,
      result: await this.externalValidationImportService.importCsv({
        provider,
        csv,
        sourceSegment: sourceSegment || EmailValidationSourceSegment.UNKNOWN,
        batchName,
        dryRun: false,
      }),
    };
  }

  @Get('zerobounce/credits')
  async getZeroBounceCredits() {
    return {
      success: true,
      result: await this.zeroBounceValidationService.getCreditBalance(),
    };
  }

  @Get('external-validation-batches')
  async listExternalValidationBatches(
    @Query('provider') provider?: ExternalValidationProvider,
    @Query('limit') limit?: number,
  ) {
    const take = Math.min(Math.max(Number(limit) || 5, 1), 25);
    const where = provider ? { provider } : {};
    const batches = await this.emailValidationBatchRepository.find({
      where,
      order: { id: 'DESC' },
      take,
    });

    return {
      success: true,
      result: batches.map((batch) => this.mapExternalValidationBatch(batch)),
    };
  }

  @Get('zerobounce/segments/preview')
  async previewZeroBounceSegment(
    @Query('segment') segment?: ZeroBounceSegment,
    @Query('limit') limit?: number,
  ) {
    return {
      success: true,
      result: await this.zeroBounceValidationService.previewSegment({
        segment,
        limit,
      }),
    };
  }

  @Post('zerobounce/validate')
  async validateZeroBounceSegment(
    @Body('segment') segment?: ZeroBounceSegment,
    @Body('limit') limit?: number,
    @Body('dryRun') dryRun?: boolean,
  ) {
    return {
      success: true,
      result: await this.zeroBounceValidationService.validateSegment({
        segment,
        limit,
        dryRun,
      }),
    };
  }

  @Post('zerobounce/exclude')
  async excludeZeroBounceCandidate(
    @Body('emailId') emailId?: number,
    @Body('email') email?: string,
    @Body('note') note?: string,
  ) {
    return {
      success: true,
      result: await this.zeroBounceValidationService.excludeFromExternalValidation({
        emailId,
        email,
        note,
      }),
    };
  }

  @Post('elastic-email/pull')
  async pullElasticEmailEvents(
    @Body('from') from?: string,
    @Body('to') to?: string,
    @Body('limit') limit?: number,
    @Body('offset') offset?: number,
    @Body('status') status?: string,
    @Body('dryRun') dryRun?: boolean,
  ) {
    return {
      success: true,
      result: await this.elasticEmailIngestionService.pullLegacyEvents({
        from,
        to,
        limit,
        offset,
        status,
        dryRun: dryRun !== false,
      }),
    };
  }

  @Get('suppression-overview')
  async getSuppressionOverview() {
    return {
      success: true,
      overview: await this.elasticEmailIngestionService.getSuppressionOverview(),
    };
  }

  private mapExternalValidationBatch(batch: EmailValidationBatch) {
    const metadata = this.safeMetadata(batch.metadata);
    const submittedRows = Array.isArray(metadata?.submittedRows)
      ? metadata.submittedRows
      : [];
    const providerResponse = metadata?.providerResponse || null;

    return {
      id: Number(batch.id),
      provider: batch.provider,
      status: batch.status,
      sourceSegment: batch.sourceSegment,
      name: batch.name,
      totalRecords: batch.totalRecords,
      submittedRecords: batch.submittedRecords,
      processedRecords: batch.processedRecords,
      validCount: batch.validCount,
      invalidCount: batch.invalidCount,
      riskyCount: batch.riskyCount,
      unknownCount: batch.unknownCount,
      errorMessage: batch.errorMessage,
      submittedAt: batch.submittedAt,
      completedAt: batch.completedAt,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      submittedRows,
      providerResponseSummary: metadata?.providerResponseSummary || null,
      providerResponseRows: Array.isArray(providerResponse?.email_batch)
        ? providerResponse.email_batch
        : [],
      providerErrors: Array.isArray(providerResponse?.errors)
        ? providerResponse.errors
        : [],
      request: metadata?.request || null,
      metadata: {
        source: metadata?.source || null,
        segment: metadata?.segment || null,
        creditsBefore: metadata?.creditsBefore ?? null,
        submitted: metadata?.submitted ?? submittedRows.length,
        providerResponseReceivedAt: metadata?.providerResponseReceivedAt || null,
        failedAt: metadata?.failedAt || null,
        error: metadata?.error || null,
      },
    };
  }

  private safeMetadata(metadata: any): Record<string, any> {
    if (!metadata) {
      return {};
    }

    if (typeof metadata === 'object') {
      return metadata;
    }

    try {
      return JSON.parse(metadata);
    } catch {
      return {};
    }
  }

  /**
   * Start verification for all pending emails
   * POST /api/verification/start
   */
  @Post('start')
  async startVerification(
    @Body('limit') limit?: number,
    @Body('skipSmtp') skipSmtp?: boolean,
  ) {
    this.logger.log('Starting verification batch process');

    // Get pending emails from database
    const pendingEmails = await this.emailRepository.find({
      where: {
        verificationStatus: VerificationStatus.PENDING,
      },
      take: limit || 1000,
      select: ['id', 'email'],
    });

    this.logger.log(`Found ${pendingEmails.length} pending emails to verify`);

    // Add jobs to queue
    const jobs = await Promise.all(
      pendingEmails.map((emailRecord) =>
        this.verificationQueue.add(
          'verify-email',
          {
            email: emailRecord.email,
            skipSmtp: skipSmtp || false,
          },
          {
            attempts: 2, // Retry failed jobs once
            backoff: {
              type: 'exponential',
              delay: 5000, // 5 seconds initial delay
            },
          },
        ),
      ),
    );

    return {
      success: true,
      message: `Started verification for ${jobs.length} emails`,
      jobsAdded: jobs.length,
      queueName: 'email-verification',
    };
  }

  /**
   * Start verification for specific emails by ID
   * POST /api/verification/start-by-ids
   */
  @Post('start-by-ids')
  async startVerificationByIds(
    @Body('emailIds') emailIds: number[],
    @Body('skipSmtp') skipSmtp?: boolean,
  ) {
    if (!emailIds || emailIds.length === 0) {
      return {
        success: false,
        message: 'No email IDs provided',
      };
    }

    const emails = await this.emailRepository.find({
      where: {
        id: In(emailIds),
      },
      select: ['id', 'email'],
    });

    const jobs = await Promise.all(
      emails.map((emailRecord) =>
        this.verificationQueue.add('verify-email', {
          email: emailRecord.email,
          skipSmtp: skipSmtp || false,
        }),
      ),
    );

    return {
      success: true,
      message: `Started verification for ${jobs.length} emails`,
      jobsAdded: jobs.length,
    };
  }

  /**
   * Test verification for a single email (synchronous)
   * POST /api/verification/test
   */
  @Post('test')
  async testVerification(
    @Body('email') email: string,
    @Body('skipSmtp') skipSmtp?: boolean,
  ) {
    if (!email) {
      return {
        success: false,
        message: 'Email is required',
      };
    }

    this.logger.log(`Testing verification for: ${email}`);

    const result = await this.emailVerifierService.verifyEmail(email, skipSmtp || false);

    return {
      success: true,
      result,
    };
  }

  /**
   * Audit existing email rows for common-domain typos without SMTP checks.
   * POST /api/verification/typo-audit
   */
  @Post('typo-audit')
  async auditExistingTypos(
    @Body('limit') limit?: number,
    @Body('afterId') afterId?: number,
    @Body('dryRun') dryRun?: boolean,
  ) {
    const result = await this.emailVerifierService.auditExistingTypoCandidates({
      limit,
      afterId,
      dryRun,
    });

    return {
      success: true,
      result,
    };
  }

  /**
   * Audit customers.email for common-domain typos without changing customers.email.
   * Detected rows are saved into the email typo recovery queue.
   * POST /api/verification/customer-typo-audit
   */
  @Post('customer-typo-audit')
  async auditCustomerTypos(
    @Body('limit') limit?: number,
    @Body('afterId') afterId?: number,
    @Body('dryRun') dryRun?: boolean,
  ) {
    const result = await this.emailVerifierService.auditCustomerTypoCandidates({
      limit,
      afterId,
      dryRun,
    });

    return {
      success: true,
      result,
    };
  }

  @Post('typo-audit/reset-progress')
  async resetTypoAuditProgress(@Body('scope') scope?: 'emails' | 'customers' | 'all') {
    const safeScope = scope === 'emails' || scope === 'customers' ? scope : 'all';
    const result = safeScope === 'all'
      ? {
          emails: await this.emailVerifierService.resetTypoScanProgress('emails'),
          customers: await this.emailVerifierService.resetTypoScanProgress('customers'),
        }
      : await this.emailVerifierService.resetTypoScanProgress(safeScope);

    return {
      success: true,
      scope: safeScope,
      result,
    };
  }

  @Post('typo-audit/full-scan/start')
  async startFullTypoScan(@Body('chunkSize') chunkSize?: number) {
    const active = await this.typoScanQueue.getActive();
    const waiting = await this.typoScanQueue.getWaiting();
    const existing = [...active, ...waiting][0];

    if (existing) {
      return {
        success: true,
        queue: await this.getTypoScanQueueCounts(),
        job: await this.serializeTypoScanJob(existing),
        alreadyRunning: true,
      };
    }

    const job = await this.typoScanQueue.add(
      'full-typo-scan',
      {
        chunkSize: Math.min(Math.max(Number(chunkSize) || 50000, 1000), 100000),
      },
      {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return {
      success: true,
      queue: await this.getTypoScanQueueCounts(),
      job: await this.serializeTypoScanJob(job),
      alreadyRunning: false,
    };
  }

  @Get('typo-audit/full-scan/status')
  async getFullTypoScanStatus() {
    const [active, waiting, completed, failed, queue] = await Promise.all([
      this.typoScanQueue.getActive(0, 1),
      this.typoScanQueue.getWaiting(0, 1),
      this.typoScanQueue.getCompleted(0, 1),
      this.typoScanQueue.getFailed(0, 1),
      this.getTypoScanQueueCounts(),
    ]);

    const job = active[0] || waiting[0] || completed[0] || failed[0] || null;

    return {
      success: true,
      queue,
      job: job ? await this.serializeTypoScanJob(job) : null,
    };
  }

  /**
   * Get queue statistics
   * GET /api/verification/queue-stats
   */
  @Get('queue-stats')
  async getQueueStats() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.verificationQueue.getWaitingCount(),
      this.verificationQueue.getActiveCount(),
      this.verificationQueue.getCompletedCount(),
      this.verificationQueue.getFailedCount(),
    ]);

    return {
      success: true,
      queue: {
        name: 'email-verification',
        waiting,
        active,
        completed,
        failed,
        total: waiting + active + completed + failed,
      },
    };
  }

  /**
   * Get verification statistics
   * GET /api/verification/stats
   */
  @Get('stats')
  async getVerificationStats() {
    // Get email counts by verification status
    const statusCounts = await this.emailRepository
      .createQueryBuilder('email')
      .select('email.verificationStatus', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('email.verificationStatus')
      .getRawMany();

    // Get average quality score
    const avgScoreResult = await this.emailRepository
      .createQueryBuilder('email')
      .select('AVG(email.qualityScore)', 'avgScore')
      .where('email.qualityScore IS NOT NULL')
      .getRawOne();

    // Get recent verification history
    const recentVerifications = await this.verificationHistoryRepository.find({
      order: { verifiedAt: 'DESC' },
      take: 10,
      relations: ['email'],
    });

    // Format status counts
    const byStatus = statusCounts.reduce((acc, row) => {
      acc[row.status] = parseInt(row.count, 10);
      return acc;
    }, {});

    return {
      success: true,
      stats: {
        byStatus,
        averageQualityScore: parseFloat(avgScoreResult?.avgScore || '0').toFixed(2),
        recentVerifications: recentVerifications.map((v) => ({
          email: v.email?.email,
          status: v.finalStatus,
          qualityScore: v.qualityScore,
          verifiedAt: v.verifiedAt,
          durationMs: v.durationMs,
        })),
      },
    };
  }

  /**
   * Clear completed jobs from queue
   * POST /api/verification/clear-completed
   */
  @Post('clear-completed')
  async clearCompletedJobs() {
    await this.verificationQueue.clean(0, 1000, 'completed');
    await this.verificationQueue.clean(0, 1000, 'failed');

    return {
      success: true,
      message: 'Completed and failed jobs cleared from queue',
    };
  }

  /**
   * Pause verification queue
   * POST /api/verification/pause
   */
  @Post('pause')
  async pauseQueue() {
    await this.verificationQueue.pause();

    return {
      success: true,
      message: 'Verification queue paused',
    };
  }

  /**
   * Resume verification queue
   * POST /api/verification/resume
   */
  @Post('resume')
  async resumeQueue() {
    await this.verificationQueue.resume();

    return {
      success: true,
      message: 'Verification queue resumed',
    };
  }

  private async serializeTypoScanJob(job: any) {
    return {
      id: job.id,
      name: job.name,
      state: await job.getState(),
      progress: job.progress,
      data: job.data,
      result: job.returnvalue,
      failedReason: job.failedReason,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  private async getTypoScanQueueCounts() {
    const [active, waiting, completed, failed] = await Promise.all([
      this.typoScanQueue.getActiveCount(),
      this.typoScanQueue.getWaitingCount(),
      this.typoScanQueue.getCompletedCount(),
      this.typoScanQueue.getFailedCount(),
    ]);

    return {
      active,
      waiting,
      completed,
      failed,
    };
  }
}
