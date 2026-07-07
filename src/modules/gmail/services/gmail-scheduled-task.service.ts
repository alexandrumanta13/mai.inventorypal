import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GmailScanJobData } from '../processors/gmail-scan.processor';

/**
 * Gmail Scheduled Task Service
 *
 * Manages automated daily Gmail scans via cron jobs
 */
@Injectable()
export class GmailScheduledTask {
  private readonly logger = new Logger(GmailScheduledTask.name);

  constructor(
    @InjectQueue('gmail-scan') private readonly gmailScanQueue: Queue<GmailScanJobData>,
  ) {}

  /**
   * Daily full Gmail scan
   * Runs at 2:00 AM every day
   *
   * Scans for:
   * - Unsubscribe requests
   * - Bounced emails
   * - Order confirmations
   * - Abusive/offensive emails
   *
   * Scans emails from the last 90 days with no limit (scans all matching emails)
   */
  @Cron('0 2 * * *', {
    name: 'daily-gmail-full-scan',
    timeZone: 'Europe/Bucharest', // Romania timezone
  })
  async handleDailyFullScan() {
    this.logger.log('🕒 Starting daily Gmail full scan (scheduled at 2:00 AM)');

    try {
      const [activeCount, waitingCount, delayedCount] = await Promise.all([
        this.gmailScanQueue.getActiveCount(),
        this.gmailScanQueue.getWaitingCount(),
        this.gmailScanQueue.getDelayedCount(),
      ]);

      if (activeCount || waitingCount || delayedCount) {
        this.logger.warn(
          `Skipping daily Gmail scan because gmail-scan queue is busy: active=${activeCount}, waiting=${waitingCount}, delayed=${delayedCount}`,
        );
        return;
      }

      const job = await this.gmailScanQueue.add(
        'daily-smart-scan',
        {
          scanType: 'smart',
          daysBack: 7,
          autoUpdate: true,
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 10000,
          },
          removeOnComplete: {
            age: 604800,
            count: 10,
          },
          removeOnFail: false,
        },
      );

      this.logger.log(
        `✅ Daily smart Gmail scan queued successfully (Job ID: ${job.id})
        Job will process recent non-spam/non-trash mail with cheap filters before body/LLM reads.
        Monitor progress at /api/gmail/scan/queue/jobs`
      );
    } catch (error) {
      this.logger.error(`❌ Failed to queue daily Gmail scan jobs: ${error.message}`, error.stack);
    }
  }

  /**
   * Manual trigger for daily scan (useful for testing)
   * Can be called via a separate endpoint if needed
   */
  async triggerDailyScan() {
    this.logger.log('Manual trigger of daily Gmail scan');
    return this.handleDailyFullScan();
  }
}
