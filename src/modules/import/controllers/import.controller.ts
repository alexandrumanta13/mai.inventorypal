import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Public } from '@modules/auth/decorators/public.decorator';
import { JsonImportService } from '../services/json-import.service';
import { CsvImportService } from '../services/csv-import.service';
import { WooCommerceImportService } from '../services/woocommerce-import.service';
import { InventoryPalImportService } from '../services/inventorypal-import.service';

@Controller('imports')
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(
    private readonly jsonImportService: JsonImportService,
    private readonly csvImportService: CsvImportService,
    private readonly wooCommerceImportService: WooCommerceImportService,
    private readonly inventoryPalImportService: InventoryPalImportService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Start JSON pages import
   * POST /api/imports/json-pages
   */
  @Post('json-pages')
  async startJsonImport() {
    this.logger.log('Starting JSON pages import');

    const job = await this.jsonImportService.startJsonImport();

    return {
      success: true,
      jobId: job.id,
      message: 'JSON import job started',
      status: job.status,
    };
  }

  /**
   * Start CSV import
   * POST /api/imports/csv
   */
  @Post('csv')
  async startCsvImport() {
    this.logger.log('Starting CSV import');

    const job = await this.csvImportService.startCsvImport();

    return {
      success: true,
      jobId: job.id,
      message: 'CSV import job started',
      status: job.status,
    };
  }

  /**
   * Preview InventoryPal/SuppliKit sync source
   * GET /api/imports/inventorypal/overview
   */
  @Get('inventorypal/overview')
  async getInventoryPalOverview(@Query('daysBack') daysBack?: string) {
    const overview = await this.inventoryPalImportService.getSyncOverview(
      daysBack ? Number(daysBack) : 7,
    );

    return {
      success: true,
      overview,
    };
  }

  /**
   * Audit SuppliKit orders that are missing email but can be matched by phone.
   * GET /api/imports/inventorypal/recoverable-missing-emails
   */
  @Get('inventorypal/recoverable-missing-emails')
  async getRecoverableMissingEmails(
    @Query('daysBack') daysBack?: string,
    @Query('limit') limit?: string,
    @Query('domainId') domainId?: string,
  ) {
    const audit = await this.inventoryPalImportService.getRecoverableMissingEmails({
      daysBack: daysBack ? Number(daysBack) : 365,
      limit: limit ? Number(limit) : 250,
      domainId: domainId ? Number(domainId) : undefined,
    });

    return {
      success: true,
      audit,
    };
  }

  /**
   * Recover high-confidence missing emails by phone.
   * POST /api/imports/inventorypal/recoverable-missing-emails/recover
   */
  @Post('inventorypal/recoverable-missing-emails/recover')
  async recoverMissingEmailsByPhone(
    @Body('daysBack') daysBack?: number,
    @Body('limit') limit?: number,
    @Body('domainId') domainId?: number,
    @Body('dryRun') dryRun?: boolean,
  ) {
    const result = await this.inventoryPalImportService.recoverMissingEmailsByPhone({
      daysBack,
      limit,
      domainId,
      dryRun: dryRun !== false,
    });

    return {
      success: true,
      result,
    };
  }

  /**
   * Manually recover one review row from the quality queue.
   * POST /api/imports/inventorypal/recoverable-missing-emails/recover-review
   */
  @Post('inventorypal/recoverable-missing-emails/recover-review')
  async recoverReviewMissingEmailByPhone(
    @Body('orderId') orderId: number,
    @Body('candidateEmail') candidateEmail: string,
    @Body('daysBack') daysBack?: number,
    @Body('domainId') domainId?: number,
    @Body('dryRun') dryRun?: boolean,
  ) {
    const result = await this.inventoryPalImportService.recoverMissingEmailByPhoneReview({
      orderId,
      candidateEmail,
      daysBack,
      domainId,
      dryRun: dryRun !== false,
    });

    return {
      success: true,
      result,
    };
  }

  /**
   * Import new customers from InventoryPal/SuppliKit order sync database
   * POST /api/imports/inventorypal
   */
  @Post('inventorypal')
  async startInventoryPalImport(
    @Body('daysBack') daysBack?: number,
    @Body('limit') limit?: number,
  ) {
    this.logger.log('Starting InventoryPal/SuppliKit customer import');

    const job = await this.inventoryPalImportService.startInventoryPalImport({
      daysBack,
      limit,
    });

    return {
      success: true,
      jobId: job.id,
      message: 'InventoryPal customer import job started',
      status: job.status,
    };
  }

  /**
   * Non-blocking SuppliKit webhook signal.
   * POST /api/imports/inventorypal/webhook
   */
  @Public()
  @Post('inventorypal/webhook')
  @HttpCode(202)
  async receiveInventoryPalWebhook(
    @Headers('x-inventorypal-webhook-secret') webhookSecret?: string,
    @Body() payload?: Record<string, unknown>,
  ) {
    this.verifyInventoryPalWebhookSecret(webhookSecret);

    const result = await this.inventoryPalImportService.triggerWebhookImport();
    if (!result.accepted && result.reason === 'inventorypal_source_not_configured') {
      throw new ServiceUnavailableException('InventoryPal SuppliKit sync source is not configured');
    }

    this.logger.log(
      `InventoryPal webhook accepted: ${result.skipped ? result.reason : `job ${result.jobId}`} (${this.describeWebhookPayload(payload)})`,
    );

    return {
      success: true,
      accepted: true,
      nonBlocking: true,
      ...result,
    };
  }

  /**
   * Get import job status
   * GET /api/imports/jobs/:id
   */
  @Get('jobs/:id')
  async getJobStatus(@Param('id', ParseIntPipe) id: number) {
    const job = await this.jsonImportService.getJobStatus(id);

    if (!job) {
      return {
        success: false,
        message: 'Job not found',
      };
    }

    // Calculate progress percentage
    const progress = job.totalFiles > 0
      ? Math.round((job.processedFiles / job.totalFiles) * 100)
      : 0;

    return {
      success: true,
      job: {
        id: job.id,
        sourceType: job.sourceType,
        status: job.status,
        progress: {
          percentage: progress,
          filesProcessed: job.processedFiles,
          totalFiles: job.totalFiles,
          recordsProcessed: job.processedRecords,
          totalRecords: job.totalRecords,
        },
        results: {
          importedEmails: job.importedEmails,
          duplicateEmails: job.duplicateEmails,
          invalidEmails: job.invalidEmails,
        },
        timestamps: {
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
        },
        errorMessage: job.errorMessage,
      },
    };
  }

  /**
   * Get all import jobs
   * GET /api/imports/jobs
   */
  @Get('jobs')
  async getAllJobs() {
    await this.inventoryPalImportService.reconcileStaleImportJobs();
    const jobs = await this.jsonImportService.getAllJobs();

    return {
      success: true,
      jobs: jobs.map((job) => ({
        id: job.id,
        sourceType: job.sourceType,
        status: job.status,
        importedEmails: job.importedEmails,
        duplicateEmails: job.duplicateEmails,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
      })),
    };
  }

  /**
   * Import customers from specific WooCommerce domain
   * POST /api/imports/woocommerce/:domainId
   */
  @Post('woocommerce/:domainId')
  async importFromWooCommerceDomain(@Param('domainId', ParseIntPipe) domainId: number) {
    this.logger.log(`Starting WooCommerce import from domain ID ${domainId}`);

    const result = await this.wooCommerceImportService.importFromDomain(domainId);

    return {
      success: true,
      result,
    };
  }

  /**
   * Import customers from ALL active WooCommerce domains
   * POST /api/imports/woocommerce
   */
  @Post('woocommerce')
  async importFromAllWooCommerceDomains() {
    this.logger.log('Starting WooCommerce import from all active domains');

    const result = await this.wooCommerceImportService.importFromAllDomains();

    return {
      success: true,
      ...result,
    };
  }

  private verifyInventoryPalWebhookSecret(providedSecret?: string): void {
    const expectedSecret = this.configService.get<string>('INVENTORYPAL_WEBHOOK_SECRET');

    if (!expectedSecret) {
      throw new ServiceUnavailableException('InventoryPal webhook secret is not configured');
    }

    if (!providedSecret || !this.safeEquals(providedSecret, expectedSecret)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
  }

  private safeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }

    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private describeWebhookPayload(payload?: Record<string, unknown>): string {
    if (!payload) {
      return 'empty payload';
    }

    const orderId = payload.orderId || payload.order_id || payload.woocommerceOrderId || payload.id;
    const domainId = payload.domainId || payload.domain_id || payload.authorizedDomainId;
    return `order=${orderId || 'unknown'}, domain=${domainId || 'unknown'}`;
  }
}
