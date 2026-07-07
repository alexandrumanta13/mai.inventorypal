import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailVerifierService, TypoAuditResult } from '../services/email-verifier.service';

export interface TypoScanJobData {
  chunkSize?: number;
}

export interface TypoScanJobProgress {
  phase: 'emails' | 'customers' | 'done';
  emails: TypoScanPhaseProgress;
  customers: TypoScanPhaseProgress;
}

export interface TypoScanPhaseProgress {
  scanned: number;
  found: number;
  saved: number;
  clean: number;
  remaining: number | null;
  completed: boolean;
}

@Processor('typo-scan', {
  concurrency: 1,
})
export class TypoScanProcessor extends WorkerHost {
  private readonly logger = new Logger(TypoScanProcessor.name);

  constructor(private readonly emailVerifierService: EmailVerifierService) {
    super();
  }

  async process(job: Job<TypoScanJobData>): Promise<TypoScanJobProgress> {
    const chunkSize = Math.min(Math.max(Number(job.data?.chunkSize) || 50000, 1000), 100000);
    const progress: TypoScanJobProgress = {
      phase: 'emails',
      emails: this.emptyPhaseProgress(),
      customers: this.emptyPhaseProgress(),
    };

    this.logger.log(`Starting full typo scan with chunk size ${chunkSize}`);

    await this.scanPhase(job, progress, 'emails', chunkSize);
    progress.phase = 'customers';
    await job.updateProgress(progress);

    await this.scanPhase(job, progress, 'customers', chunkSize);
    progress.phase = 'done';
    await job.updateProgress(progress);

    this.logger.log(
      `Full typo scan completed. Emails scanned=${progress.emails.scanned}, Customers scanned=${progress.customers.scanned}`,
    );

    return progress;
  }

  private async scanPhase(
    job: Job<TypoScanJobData>,
    progress: TypoScanJobProgress,
    phase: 'emails' | 'customers',
    chunkSize: number,
  ): Promise<void> {
    while (true) {
      const result = phase === 'emails'
        ? await this.emailVerifierService.auditExistingTypoCandidates({
            limit: chunkSize,
            dryRun: false,
          })
        : await this.emailVerifierService.auditCustomerTypoCandidates({
            limit: chunkSize,
            dryRun: false,
          });

      this.mergeResult(progress[phase], result);
      progress.phase = phase;
      await job.updateProgress(progress);

      if (result.completed || result.scanned === 0) {
        progress[phase].completed = true;
        progress[phase].remaining = result.remaining || 0;
        await job.updateProgress(progress);
        return;
      }
    }
  }

  private mergeResult(target: TypoScanPhaseProgress, result: TypoAuditResult): void {
    target.scanned += result.scanned;
    target.found += result.typosFound;
    target.saved += result.updated;
    target.clean += result.clean || 0;
    target.remaining = result.remaining;
    target.completed = result.completed;
  }

  private emptyPhaseProgress(): TypoScanPhaseProgress {
    return {
      scanned: 0,
      found: 0,
      saved: 0,
      clean: 0,
      remaining: null,
      completed: false,
    };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<TypoScanJobData>) {
    this.logger.log(`Typo scan job ${job.id} completed`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<TypoScanJobData>, error: Error) {
    this.logger.error(`Typo scan job ${job?.id} failed: ${error.message}`, error.stack);
  }
}
