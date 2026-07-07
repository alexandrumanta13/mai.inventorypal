import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GmailService } from '../services/gmail.service';

export type ScanType = 'smart' | 'unsubscribe' | 'orders' | 'abuse';

export interface GmailScanJobData {
  scanType: ScanType;
  maxResults?: number; // Optional: if not provided, scan ALL emails
  daysBack?: number;
  afterDate?: string;
  beforeDate?: string;
  autoUpdate: boolean;
  batchSize?: number;
}

export interface ScanProgress {
  scanned: number;
  detected: number;
  updated: number;
  created: number;
  errors: number;
  currentBatch: number;
  totalBatches: number;
  pageToken?: string;
}

/**
 * BullMQ Processor for Gmail Scanning
 *
 * Processes Gmail scanning jobs in batches to avoid blocking and enable resume
 * - Batch size: 500 emails (Gmail API limit)
 * - Progress tracking: Updates after each batch
 * - Resume capable: Saves pageToken for continuation
 * - Retry logic: 2 retries with exponential backoff
 */
@Processor('gmail-scan', {
  concurrency: 1, // Process one scan at a time to avoid Gmail API rate limits
})
export class GmailScanProcessor extends WorkerHost {
  private readonly logger = new Logger(GmailScanProcessor.name);

  constructor(private readonly gmailService: GmailService) {
    super();
  }

  /**
   * Process Gmail scan job in batches
   * If maxResults is not provided, scans ALL emails until no more pages
   */
  async process(job: Job<GmailScanJobData>): Promise<ScanProgress> {
    const { scanType, maxResults, daysBack, afterDate, beforeDate, autoUpdate, batchSize = 500 } = job.data;

    const scanAll = !maxResults;
    this.logger.log(
      `Starting ${scanType} scan job ${job.id}: ${scanAll ? 'SCAN ALL EMAILS' : `maxResults=${maxResults}`}, daysBack=${daysBack}, afterDate=${afterDate}, beforeDate=${beforeDate}`,
    );

    const progress: ScanProgress = {
      scanned: 0,
      detected: 0,
      updated: 0,
      created: 0,
      errors: 0,
      currentBatch: 0,
      totalBatches: scanAll ? -1 : Math.ceil(maxResults / batchSize), // -1 means unknown total
    };

    try {
      let pageToken: string | undefined = undefined;
      let batch = 0;

      // Process in batches until no more pages (or maxResults reached)
      do {
        batch++;
        const batchMaxResults = scanAll
          ? batchSize
          : Math.min(batchSize, maxResults - progress.scanned);

        this.logger.log(
          `Processing batch ${batch}${scanAll ? '' : `/${progress.totalBatches}`} (up to ${batchMaxResults} emails)${pageToken ? ' [continuing...]' : ''}`,
        );

        let batchResult;
        switch (scanType) {
          case 'smart':
            batchResult = await this.gmailService.scanGmailSmart({
              maxResults: batchMaxResults,
              daysBack,
              afterDate,
              beforeDate,
              autoUpdate,
              pageToken,
            });
            progress.detected +=
              batchResult.ordersDetected +
              batchResult.unsubscribeDetected +
              batchResult.bounceDetected +
              batchResult.abuseDetected;
            break;

          case 'unsubscribe':
            batchResult = await this.gmailService.scanGmailForUnsubscribes({
              maxResults: batchMaxResults,
              daysBack,
              autoUpdate,
              pageToken,
            });
            progress.detected += batchResult.unsubscribeDetected + batchResult.bounceDetected;
            break;

          case 'orders':
            batchResult = await this.gmailService.scanGmailForOrders({
              maxResults: batchMaxResults,
              daysBack,
              autoUpdate,
              pageToken,
            });
            progress.detected += batchResult.ordersDetected;
            break;

          case 'abuse':
            batchResult = await this.gmailService.scanGmailForAbuse({
              maxResults: batchMaxResults,
              daysBack,
              autoUpdate,
              pageToken,
            });
            progress.detected += batchResult.abuseDetected;
            break;
        }

        // Aggregate results
        progress.scanned += batchResult.scanned;
        progress.updated += batchResult.updated;
        progress.created += batchResult.created;
        progress.errors += batchResult.errors;
        progress.currentBatch = batch;
        progress.pageToken = batchResult.nextPageToken;

        // Update job progress
        if (scanAll) {
          // For unlimited scans, we can't show percentage, just report scanned count
          await job.updateProgress(progress.scanned);
        } else {
          // For limited scans, show percentage
          const percentage = Math.round((progress.scanned / maxResults) * 100);
          await job.updateProgress(percentage);
        }

        this.logger.log(
          `Batch ${batch} complete: ${batchResult.scanned} scanned, ${progress.detected} total detected, ${progress.scanned} total scanned`,
        );

        // Get next page token
        pageToken = batchResult.nextPageToken;

        // Small delay between batches to avoid hitting Gmail API rate limits
        if (pageToken || (maxResults && progress.scanned < maxResults)) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Continue if:
        // - Scanning all emails AND there's a next page token
        // - OR scanning limited emails AND haven't reached max AND there's a next page token
      } while (
        pageToken &&
        (scanAll || progress.scanned < maxResults)
      );

      this.logger.log(
        `${scanType} scan job ${job.id} completed: ${progress.scanned} scanned, ${progress.detected} detected, ${batch} batches processed`,
      );

      return progress;
    } catch (error) {
      this.logger.error(`${scanType} scan job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<GmailScanJobData>, result: ScanProgress) {
    this.logger.log(
      `Job ${job.id} completed: ${result.scanned} scanned, ${result.detected} detected, ${result.updated} updated, ${result.created} created`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<GmailScanJobData>, error: Error) {
    this.logger.error(
      `Job ${job.id} failed permanently: ${job.data.scanType} scan - ${error.message}`,
    );
  }

  @OnWorkerEvent('active')
  onActive(job: Job<GmailScanJobData>) {
    this.logger.log(`Job ${job.id} started: ${job.data.scanType} scan`);
  }

  @OnWorkerEvent('progress')
  onProgress(job: Job<GmailScanJobData>, progress: number) {
    this.logger.debug(`Job ${job.id} progress: ${progress}%`);
  }
}
