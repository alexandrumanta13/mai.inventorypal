import { Controller, Get, Post, Query, Body, Param, Delete, Res } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { FastifyReply } from 'fastify';
import { GmailService } from '../services/gmail.service';
import { GmailScanJobData, ScanType } from '../processors/gmail-scan.processor';
import { ScanProgressService } from '../services/scan-progress.service';
import { Public } from '../../auth/decorators/public.decorator';

@Controller('gmail')
export class GmailController {
  constructor(
    private readonly gmailService: GmailService,
    private readonly scanProgressService: ScanProgressService,
    @InjectQueue('gmail-scan') private readonly gmailScanQueue: Queue<GmailScanJobData>,
  ) {}

  private isValidDateInput(value?: string): boolean {
    return !value || !Number.isNaN(new Date(value).getTime());
  }

  /**
   * Get OAuth2 authorization URL
   */
  @Public()
  @Get('auth-url')
  getAuthUrl() {
    return {
      authUrl: this.gmailService.getAuthUrl(),
      message: 'Visit this URL to authorize Gmail access',
    };
  }

  /**
   * OAuth2 callback endpoint
   */
  @Public()
  @Get('oauth2callback')
  async oauth2Callback(@Query('code') code: string) {
    if (!code) {
      return {
        error: 'Authorization code not provided',
      };
    }

    try {
      const tokens = await this.gmailService.getTokenFromCode(code);

      return {
        message: 'Authorization successful',
        refreshToken: tokens.refresh_token,
        instructions: `Add this to your .env file:\nGMAIL_REFRESH_TOKEN=${tokens.refresh_token}`,
      };
    } catch (error) {
      return {
        error: 'Failed to exchange authorization code',
        details: error.message,
      };
    }
  }

  /**
   * Get OAuth2 configuration status
   */
  @Public()
  @Get('status')
  getStatus() {
    const status = this.gmailService.getOAuthStatus();

    return {
      ...status,
      message: status.configured && status.hasRefreshToken
        ? 'Gmail API is fully configured'
        : 'Gmail API is not configured. Use /api/gmail/auth-url to get started.',
    };
  }

  /**
   * Server-Sent Events endpoint for real-time scan progress
   * Streams progress updates to frontend every 500ms
   */
  @Public()
  @Get('scan/progress')
  async streamScanProgress(@Res({ passthrough: false }) reply: FastifyReply) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial progress
    const initialProgress = this.scanProgressService.getProgress();
    const initialPercentage = this.scanProgressService.getPercentage();
    reply.raw.write(`data: ${JSON.stringify({ ...initialProgress, percentage: initialPercentage })}\n\n`);

    // Stream progress updates every 500ms
    const interval = setInterval(() => {
      const progress = this.scanProgressService.getProgress();
      const percentage = this.scanProgressService.getPercentage();

      const data = {
        ...progress,
        percentage,
      };

      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

      // Close connection when scan is complete and idle for 2 seconds
      if (!progress.isScanning && progress.phase === 'idle' && progress.totalScanned > 0) {
        clearInterval(interval);
        reply.raw.end();
      }
    }, 500);

    // Cleanup on client disconnect
    reply.raw.on('close', () => {
      clearInterval(interval);
    });
  }

  /**
   * Scan Gmail for unsubscribe requests and bounced emails
   */
  @Post('scan')
  async scanGmail(
    @Body()
    body: {
      maxResults?: number;
      daysBack?: number;
      afterDate?: string;
      beforeDate?: string;
      autoUpdate?: boolean;
    } = {},
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    try {
      const result = await this.gmailService.scanGmailForUnsubscribes({
        maxResults: body.maxResults || 500,
        daysBack: body.daysBack || 90,
        autoUpdate: body.autoUpdate !== false, // Default to true
      });

      return {
        message: 'Gmail scan completed successfully',
        result,
      };
    } catch (error) {
      return {
        error: 'Gmail scan failed',
        details: error.message,
      };
    }
  }

  /**
   * Dry run scan (no database updates)
   */
  @Post('scan/dry-run')
  async scanGmailDryRun(
    @Body()
    body: {
      maxResults?: number;
      daysBack?: number;
    } = {},
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    try {
      const result = await this.gmailService.scanGmailForUnsubscribes({
        maxResults: body.maxResults || 100,
        daysBack: body.daysBack || 90,
        autoUpdate: false, // Dry run - no updates
      });

      return {
        message: 'Gmail dry run scan completed successfully (no database updates)',
        result,
      };
    } catch (error) {
      return {
        error: 'Gmail scan failed',
        details: error.message,
      };
    }
  }

  /**
   * Scan Gmail for order confirmation emails
   */
  @Post('scan/orders')
  async scanGmailOrders(
    @Body()
    body: {
      maxResults?: number;
      daysBack?: number;
      afterDate?: string;
      beforeDate?: string;
      autoUpdate?: boolean;
    } = {},
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    try {
      const result = await this.gmailService.scanGmailForOrders({
        maxResults: body.maxResults || 500,
        daysBack: body.daysBack || 90,
        autoUpdate: body.autoUpdate !== false, // Default to true
      });

      return {
        message: 'Gmail order scan completed successfully',
        result,
      };
    } catch (error) {
      return {
        error: 'Gmail order scan failed',
        details: error.message,
      };
    }
  }

  /**
   * Scan Gmail for abusive/offensive emails
   */
  @Post('scan/abuse')
  async scanGmailAbuse(
    @Body()
    body: {
      maxResults?: number;
      daysBack?: number;
      autoUpdate?: boolean;
    } = {},
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    try {
      const result = await this.gmailService.scanGmailForAbuse({
        maxResults: body.maxResults || 500,
        daysBack: body.daysBack || 90,
        autoUpdate: body.autoUpdate !== false, // Default to true
      });

      return {
        message: 'Gmail abuse scan completed successfully',
        result,
      };
    } catch (error) {
      return {
        error: 'Gmail abuse scan failed',
        details: error.message,
      };
    }
  }

  /**
   * Full scan - combines unsubscribe, orders, and abuse scans
   * This endpoint runs all scan types sequentially and returns combined results
   */
  @Post('scan/full')
  async scanGmailFull(
    @Body()
    body: {
      maxResults?: number;
      daysBack?: number;
      afterDate?: string;
      beforeDate?: string;
      autoUpdate?: boolean;
    } = {},
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    try {
      const maxResults = body.maxResults || 500;
      const daysBack = body.daysBack;
      const afterDate = body.afterDate;
      const beforeDate = body.beforeDate;
      const autoUpdate = body.autoUpdate !== false;

      if (!this.isValidDateInput(afterDate) || !this.isValidDateInput(beforeDate)) {
        return {
          error: 'Invalid date window',
          message: 'afterDate and beforeDate must be valid date strings, for example 2026-06-01',
        };
      }

      const startTime = Date.now();

      this.scanProgressService.startScan(maxResults);

      const result = await this.gmailService.scanGmailSmart({
        maxResults,
        daysBack,
        afterDate,
        beforeDate,
        autoUpdate,
      });

      // Finish progress tracking
      this.scanProgressService.finishScan();

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      return {
        message: 'Smart Gmail scan completed successfully',
        stats: {
          ...result,
          durationSeconds: duration,
        },
      };
    } catch (error) {
      return {
        error: 'Full Gmail scan failed',
        details: error.message,
      };
    }
  }

  /**
   * Get statistics about Gmail-scanned emails
   */
  @Get('scan/stats')
  async getGmailStats() {
    try {
      const stats = await this.gmailService.getGmailScanStats();

      return {
        message: 'Gmail scan statistics retrieved successfully',
        stats,
      };
    } catch (error) {
      return {
        error: 'Failed to get Gmail scan statistics',
        details: error.message,
      };
    }
  }

  /**
   * Start a background Gmail scan job (queue-based)
   */
  @Post('scan/queue/start')
  async startQueueScan(
    @Body()
    body: {
      scanType: ScanType;
      maxResults?: number;
      daysBack?: number;
      afterDate?: string;
      beforeDate?: string;
      autoUpdate?: boolean;
    },
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    if (!body.scanType || !['smart', 'unsubscribe', 'orders', 'abuse'].includes(body.scanType)) {
      return {
        error: 'Invalid scan type',
        message: 'scanType must be one of: smart, unsubscribe, orders, abuse',
      };
    }

    if (!this.isValidDateInput(body.afterDate) || !this.isValidDateInput(body.beforeDate)) {
      return {
        error: 'Invalid date window',
        message: 'afterDate and beforeDate must be valid date strings, for example 2026-06-01',
      };
    }

    try {
      // Add job to queue
      // If maxResults is not provided, scan ALL emails
      const job = await this.gmailScanQueue.add(
        `${body.scanType}-scan`,
          {
            scanType: body.scanType,
            maxResults: body.maxResults, // undefined = scan all
            daysBack: body.daysBack ?? (body.scanType === 'smart' ? undefined : 90),
            afterDate: body.afterDate,
            beforeDate: body.beforeDate,
            autoUpdate: body.autoUpdate !== false,
          },
        {
          attempts: 2, // Retry twice on failure
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: false, // Keep completed jobs for status checking
          removeOnFail: false, // Keep failed jobs for debugging
        },
      );

      return {
        message: 'Gmail scan job started',
        jobId: job.id,
        scanType: body.scanType,
        mode: body.maxResults ? `Limited to ${body.maxResults} emails` : 'Scanning ALL emails',
        window: {
          daysBack: body.daysBack ?? (body.scanType === 'smart' ? undefined : 90),
          afterDate: body.afterDate,
          beforeDate: body.beforeDate,
        },
        instructions: `Use GET /api/gmail/scan/queue/status/${job.id} to check progress`,
      };
    } catch (error) {
      return {
        error: 'Failed to start scan job',
        details: error.message,
      };
    }
  }

  /**
   * Get status of a Gmail scan job
   */
  @Get('scan/queue/status/:jobId')
  async getQueueScanStatus(@Param('jobId') jobId: string) {
    try {
      const job = await this.gmailScanQueue.getJob(jobId);

      if (!job) {
        return {
          error: 'Job not found',
          message: `No job found with ID: ${jobId}`,
        };
      }

      const state = await job.getState();
      const progress = job.progress;
      const result = job.returnvalue;

      return {
        jobId: job.id,
        state, // 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'
        progress, // 0-100
        result,
        createdAt: new Date(job.timestamp),
        processedAt: job.processedOn ? new Date(job.processedOn) : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
        failedReason: job.failedReason,
      };
    } catch (error) {
      return {
        error: 'Failed to get job status',
        details: error.message,
      };
    }
  }

  /**
   * Get all active and completed Gmail scan jobs
   */
  @Get('scan/queue/jobs')
  async getQueueJobs() {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        this.gmailScanQueue.getWaiting(0, 10),
        this.gmailScanQueue.getActive(0, 10),
        this.gmailScanQueue.getCompleted(0, 10),
        this.gmailScanQueue.getFailed(0, 10),
      ]);

      return {
        waiting: waiting.map((j) => ({ id: j.id, name: j.name, data: j.data })),
        active: active.map((j) => ({ id: j.id, name: j.name, progress: j.progress })),
        completed: completed.map((j) => ({
          id: j.id,
          name: j.name,
          result: j.returnvalue,
        })),
        failed: failed.map((j) => ({
          id: j.id,
          name: j.name,
          error: j.failedReason,
        })),
      };
    } catch (error) {
      return {
        error: 'Failed to get jobs',
        details: error.message,
      };
    }
  }

  /**
   * Stop and remove a Gmail scan job
   */
  @Delete('scan/queue/jobs/:jobId')
  async removeQueueJob(@Param('jobId') jobId: string) {
    try {
      const job = await this.gmailScanQueue.getJob(jobId);

      if (!job) {
        return {
          error: 'Job not found',
          message: `No job found with ID: ${jobId}`,
        };
      }

      const state = await job.getState();

      // Remove the job (works for active, waiting, completed, and failed jobs)
      await job.remove();

      return {
        message: 'Job removed successfully',
        jobId,
        previousState: state,
      };
    } catch (error) {
      return {
        error: 'Failed to remove job',
        details: error.message,
      };
    }
  }

  /**
   * DEBUG: Get sample emails for pattern analysis
   * Returns raw email content (subject + body) for pattern development
   */
  @Post('debug/sample-emails')
  async getSampleEmails(
    @Body()
    body: {
      category: 'orders' | 'unsubscribe' | 'abuse' | 'bounce';
      maxSamples?: number;
      daysBack?: number;
    },
  ) {
    const status = this.gmailService.getOAuthStatus();

    if (!status.configured || !status.hasRefreshToken) {
      return {
        error: 'Gmail API is not configured',
        message: 'Please configure OAuth2 credentials first. Use /api/gmail/auth-url to get started.',
      };
    }

    if (!body.category || !['orders', 'unsubscribe', 'abuse', 'bounce'].includes(body.category)) {
      return {
        error: 'Invalid category',
        message: 'category must be one of: orders, unsubscribe, abuse, bounce',
      };
    }

    try {
      const samples = await this.gmailService.getSampleEmails({
        category: body.category,
        maxSamples: body.maxSamples || 10,
        daysBack: body.daysBack || 90,
      });

      return {
        message: `Retrieved ${samples.length} sample ${body.category} emails`,
        category: body.category,
        samples,
      };
    } catch (error) {
      return {
        error: 'Failed to retrieve sample emails',
        details: error.message,
      };
    }
  }
}
