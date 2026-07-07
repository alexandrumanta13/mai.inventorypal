import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailVerifierService } from '../services/email-verifier.service';

export interface VerificationJobData {
  email: string;
  skipSmtp?: boolean;
}

/**
 * BullMQ Processor for Email Verification
 *
 * Processes email verification jobs asynchronously
 * - Concurrency: 50 workers (configured in module)
 * - Rate limiting: 100 jobs per second (configurable via env)
 * - Retry logic: 2 retries with exponential backoff
 * - Job timeout: 30 seconds per email
 *
 * Queue Strategy:
 * - SMTP verification: ~500-2000ms per email
 * - With 50 concurrent workers: ~25-100 emails/second
 * - Target: 22,000 emails/day = 0.25 emails/second (well within capacity)
 */
@Processor('email-verification', {
  concurrency: 50, // Process 50 jobs simultaneously
  limiter: {
    max: 100, // Max 100 jobs per duration
    duration: 1000, // 1 second
  },
})
export class VerificationProcessor extends WorkerHost {
  private readonly logger = new Logger(VerificationProcessor.name);

  constructor(private readonly emailVerifierService: EmailVerifierService) {
    super();
  }

  /**
   * Process email verification job
   */
  async process(job: Job<VerificationJobData, any, string>): Promise<any> {
    const { email, skipSmtp = false } = job.data;

    this.logger.debug(`Processing verification job ${job.id} for: ${email}`);

    try {
      // Verify email through all 4 layers
      const result = await this.emailVerifierService.verifyEmail(email, skipSmtp);

      this.logger.log(
        `Job ${job.id} completed: ${email} → ${result.status} (score: ${result.qualityScore})`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Job ${job.id} failed for ${email}: ${error.message}`,
        error.stack,
      );

      // Re-throw to trigger retry
      throw error;
    }
  }

  /**
   * Job completed successfully
   */
  @OnWorkerEvent('completed')
  onCompleted(job: Job<VerificationJobData>) {
    this.logger.debug(`Job ${job.id} completed: ${job.data.email}`);
  }

  /**
   * Job failed after all retries
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<VerificationJobData>, error: Error) {
    this.logger.error(
      `Job ${job.id} failed permanently: ${job.data.email} - ${error.message}`,
    );
  }

  /**
   * Job is active (started processing)
   */
  @OnWorkerEvent('active')
  onActive(job: Job<VerificationJobData>) {
    this.logger.debug(`Job ${job.id} started: ${job.data.email}`);
  }

  /**
   * Job progress update
   */
  @OnWorkerEvent('progress')
  onProgress(job: Job<VerificationJobData>, progress: number) {
    this.logger.debug(`Job ${job.id} progress: ${progress}%`);
  }
}
