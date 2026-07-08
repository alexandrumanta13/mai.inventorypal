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
   * Daily recent Gmail scan
   * Runs at 2:00 AM every day
   *
   * Scans for:
   * - Unsubscribe requests
   * - Bounced emails
   * - Order confirmations
   * - Abusive/offensive emails
   *
   * Scans the last 36 hours to cover timezone/API delays without repeatedly
   * reprocessing a full week after the historical scan is complete.
   */
  @Cron('0 2 * * *', {
    name: 'daily-gmail-recent-scan',
    timeZone: 'Europe/Bucharest', // Romania timezone
  })
  async handleDailyFullScan() {
    this.logger.log('🕒 Starting daily Gmail recent scan (scheduled at 2:00 AM)');

    try {
      if (await this.isGmailScanQueueBusy('daily Gmail scan')) {
        return;
      }

      const afterDate = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const job = await this.enqueueSmartScan(
        'daily-smart-scan',
        {
          afterDate,
          removeOnComplete: {
            age: 604800,
            count: 10,
          },
        },
      );

      this.logger.log(
        `✅ Daily smart Gmail scan queued successfully (Job ID: ${job.id})
        Window: after ${afterDate}
        Job will process recent non-spam/non-trash mail with cheap filters before body/LLM reads.
        Monitor progress at /api/gmail/scan/queue/jobs`
      );
    } catch (error) {
      this.logger.error(`❌ Failed to queue daily Gmail scan jobs: ${error.message}`, error.stack);
    }
  }

  /**
   * Weekly reconciliation scan
   * Runs every Sunday at 3:00 AM and looks back 7 days.
   *
   * This catches delayed mailbox signals without making every daily scan noisy.
   */
  @Cron('0 3 * * 0', {
    name: 'weekly-gmail-reconciliation-scan',
    timeZone: 'Europe/Bucharest',
  })
  async handleWeeklyReconciliationScan() {
    this.logger.log('🕒 Starting weekly Gmail reconciliation scan (scheduled Sunday at 3:00 AM)');

    try {
      if (await this.isGmailScanQueueBusy('weekly Gmail reconciliation')) {
        return;
      }

      const job = await this.enqueueSmartScan(
        'weekly-reconciliation-smart-scan',
        {
          daysBack: 7,
          removeOnComplete: {
            age: 1209600,
            count: 6,
          },
        },
      );

      this.logger.log(
        `✅ Weekly Gmail reconciliation scan queued successfully (Job ID: ${job.id})
        Window: last 7 days
        Monitor progress at /api/gmail/scan/queue/jobs`
      );
    } catch (error) {
      this.logger.error(`❌ Failed to queue weekly Gmail reconciliation: ${error.message}`, error.stack);
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

  private async isGmailScanQueueBusy(label: string): Promise<boolean> {
    const [activeCount, waitingCount, delayedCount] = await Promise.all([
      this.gmailScanQueue.getActiveCount(),
      this.gmailScanQueue.getWaitingCount(),
      this.gmailScanQueue.getDelayedCount(),
    ]);

    if (activeCount || waitingCount || delayedCount) {
      this.logger.warn(
        `Skipping ${label} because gmail-scan queue is busy: active=${activeCount}, waiting=${waitingCount}, delayed=${delayedCount}`,
      );
      return true;
    }

    return false;
  }

  private enqueueSmartScan(
    jobName: string,
    options: {
      daysBack?: number;
      afterDate?: string;
      removeOnComplete: {
        age: number;
        count: number;
      };
    },
  ) {
    return this.gmailScanQueue.add(
      jobName,
      {
        scanType: 'smart',
        daysBack: options.daysBack,
        afterDate: options.afterDate,
        autoUpdate: true,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
        removeOnComplete: options.removeOnComplete,
        removeOnFail: false,
      },
    );
  }
}
