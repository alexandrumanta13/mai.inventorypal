import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { createConnection, Connection } from 'mysql2/promise';
import { In, Repository } from 'typeorm';
import { CustomersService } from '@modules/customers/services/customers.service';
import { PaymentMethod } from '@modules/customers/entities/customer.entity';
import { Domain } from '@modules/domains/entities/domain.entity';
import { Email } from '@modules/emails/entities/email.entity';
import { EmailSource } from '@modules/emails/entities/email-source.entity';
import { EmailsService, CreateEmailDto } from '@modules/emails/services/emails.service';
import { SendEligibilityService } from '@modules/emails/services/send-eligibility.service';
import { ValidationIntakeGateService } from '@modules/email-verification/services/validation-intake-gate.service';
import { ImportSourceType, ImportJobSourceType, ImportJobStatus } from '@shared/enums/import-source.enum';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ImportJob } from '../entities/import-job.entity';
import { SyncState } from '../entities/sync-state.entity';

interface SyncOrderRow {
  id: number;
  authorizedDomainId: number;
  storeUrl: string | null;
  storeName: string | null;
  platform?: string | null;
  woocommerceOrderId: number;
  orderNumber: string;
  status: string;
  total: string | number;
  orderCount?: number;
  totalSpent?: string | number;
  customerEmail: string;
  customerPhone: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  paymentMethod: string | null;
  billingAddress: string | Record<string, unknown> | null;
  dateCreated: string | Date;
  firstOrderDate?: string | Date | null;
  lastOrderDate?: string | Date | null;
}

export interface SyncOverview {
  configured: boolean;
  autoImportEnabled: boolean;
  source: 'api' | 'database' | 'none';
  recentOrders: number;
  uniqueEmails: number;
  newestOrderDate: Date | null;
  syncState?: {
    status: string;
    lastAttemptedSyncAt: Date | null;
    lastSuccessfulSyncAt: Date | null;
    lastOrderDate: Date | null;
    lastJobId: number | null;
    overlapDays: number;
    maxRecoveryDays: number;
    nextDaysBack: number;
    lastErrorMessage: string | null;
  };
}

export interface RecoverableMissingEmailRow {
  orderId: number;
  authorizedDomainId: number;
  storeUrl: string | null;
  storeName: string | null;
  orderNumber: string;
  status: string;
  orderDate: Date | null;
  phone: string;
  normalizedPhone: string;
  customerName: string;
  candidateEmail: string;
  candidateName: string;
  candidateOrderId: number;
  candidateOrderDate: Date | null;
  candidateDomainId: number;
  candidateStoreUrl: string | null;
  candidateStoreName: string | null;
  confidence: 'high' | 'review';
  candidateEmailsForPhone: number;
  candidateOrdersForPhone: number;
  alreadyRecovered: boolean;
  candidateEmailInList: boolean;
  candidateEmailStatus: string | null;
}

export interface RecoverableMissingEmailAudit {
  configured: boolean;
  source: 'api' | 'database' | 'none';
  daysBack: number;
  totalMissingEmailOrders: number;
  missingWithPhoneOrders: number;
  recoverableOrders: number;
  uniqueRecoverablePhones: number;
  ambiguousPhones: number;
  alreadyRecoveredOrders: number;
  rows: RecoverableMissingEmailRow[];
}

export interface RecoverableMissingEmailRecoveryResult {
  dryRun: boolean;
  daysBack: number;
  domainId: number;
  limit: number;
  candidates: number;
  skippedReview: number;
  skippedInvalid: number;
  skippedAlreadyRecovered: number;
  customersCreated: number;
  customersUpdated: number;
  emailsCreated: number;
  emailsLinked: number;
  sourcesCreated: number;
  duplicateSources: number;
}

@Injectable()
export class InventoryPalImportService {
  private readonly logger = new Logger(InventoryPalImportService.name);
  private readonly syncKey = 'supplikit_customer_orders';
  private scheduledImportRunning = false;
  private readonly staleJobThresholdMinutes = 120;

  constructor(
    @InjectRepository(ImportJob)
    private readonly importJobRepository: Repository<ImportJob>,
    @InjectRepository(SyncState)
    private readonly syncStateRepository: Repository<SyncState>,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(EmailSource)
    private readonly emailSourceRepository: Repository<EmailSource>,
    @InjectRepository(Domain)
    private readonly domainRepository: Repository<Domain>,
    private readonly customersService: CustomersService,
    private readonly emailsService: EmailsService,
    private readonly sendEligibilityService: SendEligibilityService,
    private readonly validationIntakeGateService: ValidationIntakeGateService,
    private readonly configService: ConfigService,
  ) {}

  async getSyncOverview(daysBack = 7): Promise<SyncOverview> {
    const safeDaysBack = this.clampNumber(daysBack, 1, 365, 7);
    const syncState = await this.getSyncStateSummary(safeDaysBack);

    if (this.hasApiConfig()) {
      return {
        ...(await this.getApiOverview(safeDaysBack)),
        syncState,
      };
    }

    if (!this.hasConnectionConfig()) {
      return {
        configured: false,
        autoImportEnabled: this.isAutoImportEnabled(),
        source: 'none',
        recentOrders: 0,
        uniqueEmails: 0,
        newestOrderDate: null,
        syncState,
      };
    }

    const connection = await this.createSyncConnection();
    try {
      const [rows] = await connection.query(
        `
          SELECT
            COUNT(*) AS recentOrders,
            COUNT(DISTINCT LOWER(TRIM(o.customerEmail))) AS uniqueEmails,
            MAX(o.dateCreated) AS newestOrderDate
          FROM \`order\` o
          WHERE o.orderType = 'order'
            AND o.customerEmail IS NOT NULL
            AND o.customerEmail != ''
            AND o.dateCreated >= DATE_SUB(NOW(), INTERVAL ? DAY)
	        `,
        [safeDaysBack],
      );

      const row = (rows as any[])[0] || {};
      return {
        configured: true,
        autoImportEnabled: this.isAutoImportEnabled(),
        source: 'database',
        recentOrders: Number(row.recentOrders || 0),
        uniqueEmails: Number(row.uniqueEmails || 0),
        newestOrderDate: row.newestOrderDate ? new Date(row.newestOrderDate) : null,
        syncState,
      };
    } finally {
      await connection.end();
    }
  }

  async startInventoryPalImport(options: { daysBack?: number; limit?: number } = {}): Promise<ImportJob> {
    await this.reconcileStaleImportJobs();

    const daysBack = await this.getReconciledDaysBack(
      this.clampNumber(options.daysBack, 1, 365, 7),
    );
    const job = await this.importJobRepository.save({
      sourceType: ImportJobSourceType.INVENTORYPAL,
      status: ImportJobStatus.PENDING,
    });

    this.processInventoryPalImport(job.id, {
      daysBack,
      limit: this.clampNumber(options.limit, 1, 50000, 5000),
    }).catch((error) => {
      this.logger.error(`InventoryPal import job ${job.id} failed: ${error.message}`, error.stack);
      this.markSyncFailed(job.id, error.message);
      this.markJobFailed(job.id, error.message);
    });

    return job;
  }

  async triggerWebhookImport(): Promise<{
    accepted: boolean;
    skipped: boolean;
    reason?: string;
    jobId?: number;
    status?: ImportJobStatus;
  }> {
    await this.reconcileStaleImportJobs();

    if (!this.hasSyncSourceConfig()) {
      return {
        accepted: false,
        skipped: true,
        reason: 'inventorypal_source_not_configured',
      };
    }

    const activeJob = await this.findActiveInventoryPalJob();
    if (activeJob) {
      return {
        accepted: true,
        skipped: true,
        reason: 'already_running',
        jobId: activeJob.id,
        status: activeJob.status,
      };
    }

    const daysBack = this.clampNumber(
      this.configService.get<string>('INVENTORYPAL_WEBHOOK_IMPORT_DAYS_BACK'),
      1,
      30,
      2,
    );
    const limit = this.clampNumber(
      this.configService.get<string>('INVENTORYPAL_WEBHOOK_IMPORT_LIMIT'),
      1,
      50000,
      5000,
    );

    const job = await this.startInventoryPalImport({ daysBack, limit });

    return {
      accepted: true,
      skipped: false,
      jobId: job.id,
      status: job.status,
    };
  }

  async getRecoverableMissingEmails(options: {
    daysBack?: number;
    limit?: number;
    domainId?: number;
  } = {}): Promise<RecoverableMissingEmailAudit> {
    const query = {
      daysBack: this.clampNumber(options.daysBack, 1, 3650, 365),
      limit: this.clampNumber(options.limit, 1, 5000, 250),
      domainId: this.clampNumber(options.domainId, 0, 1_000_000, 0),
    };

    if (this.hasApiConfig()) {
      try {
        return await this.enrichRecoverableMissingEmailAudit(
          await this.getApiRecoverableMissingEmails(query),
        );
      } catch (error) {
        if (!this.hasConnectionConfig()) {
          throw error;
        }

        this.logger.warn(
          `SuppliKit recoverable missing email API unavailable, falling back to DB: ${error.message}`,
        );
      }
    }

    if (!this.hasConnectionConfig()) {
      return {
        configured: false,
        source: 'none',
        daysBack: query.daysBack,
        totalMissingEmailOrders: 0,
        missingWithPhoneOrders: 0,
        recoverableOrders: 0,
        uniqueRecoverablePhones: 0,
        ambiguousPhones: 0,
        alreadyRecoveredOrders: 0,
        rows: [],
      };
    }

    const connection = await this.createSyncConnection();
    try {
      return await this.enrichRecoverableMissingEmailAudit(
        await this.getDbRecoverableMissingEmails(connection, query),
      );
    } finally {
      await connection.end();
    }
  }

  async recoverMissingEmailsByPhone(options: {
    daysBack?: number;
    limit?: number;
    domainId?: number;
    dryRun?: boolean;
  } = {}): Promise<RecoverableMissingEmailRecoveryResult> {
    const query = {
      daysBack: this.clampNumber(options.daysBack, 1, 3650, 365),
      limit: this.clampNumber(options.limit, 1, 5000, 250),
      domainId: this.clampNumber(options.domainId, 0, 1_000_000, 0),
      dryRun: options.dryRun !== false,
    };
    const audit = await this.getRecoverableMissingEmails(query);
    const localDomains = await this.domainRepository.find();
    const result: RecoverableMissingEmailRecoveryResult = {
      dryRun: query.dryRun,
      daysBack: query.daysBack,
      domainId: query.domainId,
      limit: query.limit,
      candidates: 0,
      skippedReview: 0,
      skippedInvalid: 0,
      skippedAlreadyRecovered: 0,
      customersCreated: 0,
      customersUpdated: 0,
      emailsCreated: 0,
      emailsLinked: 0,
      sourcesCreated: 0,
      duplicateSources: 0,
    };

    for (const row of audit.rows) {
      if (row.confidence !== 'high') {
        result.skippedReview++;
        continue;
      }

      await this.recoverSingleRow(row, result, query.dryRun, localDomains, true);
    }

    if (!query.dryRun) {
      this.logger.log(
        `Recovered ${result.candidates} high-confidence missing emails by phone (domain=${query.domainId || 'all'})`,
      );
    }

    return result;
  }

  async recoverMissingEmailByPhoneReview(options: {
    orderId: number;
    candidateEmail: string;
    daysBack?: number;
    domainId?: number;
    dryRun?: boolean;
  }): Promise<RecoverableMissingEmailRecoveryResult> {
    const query = {
      daysBack: this.clampNumber(options.daysBack, 1, 3650, 365),
      limit: 5000,
      domainId: this.clampNumber(options.domainId, 0, 1_000_000, 0),
      dryRun: options.dryRun !== false,
    };
    const audit = await this.getRecoverableMissingEmails(query);
    const localDomains = await this.domainRepository.find();
    const result = this.createRecoveryResult(query);
    const candidateEmail = String(options.candidateEmail || '').trim().toLowerCase();
    const row = audit.rows.find(
      (candidate) =>
        candidate.orderId === Number(options.orderId) &&
        candidate.candidateEmail?.trim().toLowerCase() === candidateEmail,
    );

    if (!row) {
      result.skippedInvalid++;
      return result;
    }

    const rowsToRecover = audit.rows.filter(
      (candidate) =>
        candidate.normalizedPhone === row.normalizedPhone &&
        candidate.candidateEmail?.trim().toLowerCase() === candidateEmail,
    );

    for (const candidate of rowsToRecover) {
      await this.recoverSingleRow(candidate, result, query.dryRun, localDomains, false);
    }

    return result;
  }

  @Cron('*/15 * * * *', {
    name: 'inventorypal-supplikit-customer-import',
    timeZone: 'Europe/Bucharest',
  })
  async handleScheduledInventoryPalImport(): Promise<void> {
    if (!this.isAutoImportEnabled() || !this.hasSyncSourceConfig()) {
      return;
    }

    await this.reconcileStaleImportJobs();

    if (this.scheduledImportRunning) {
      this.logger.warn('Skipping scheduled InventoryPal import because the previous run is still active');
      return;
    }

    this.scheduledImportRunning = true;

    const daysBack = await this.getReconciledDaysBack(
      this.clampNumber(
        this.configService.get<string>('INVENTORYPAL_AUTO_IMPORT_DAYS_BACK'),
        1,
        30,
        1,
      ),
    );
    const limit = this.clampNumber(
      this.configService.get<string>('INVENTORYPAL_AUTO_IMPORT_LIMIT'),
      1,
      50000,
      5000,
    );

    const job = await this.importJobRepository.save({
      sourceType: ImportJobSourceType.INVENTORYPAL,
      status: ImportJobStatus.PENDING,
    });

    try {
      await this.processInventoryPalImport(job.id, { daysBack, limit });
    } catch (error) {
      this.logger.error(`Scheduled InventoryPal import job ${job.id} failed: ${error.message}`, error.stack);
      await this.markSyncFailed(job.id, error.message);
      await this.markJobFailed(job.id, error.message);
    } finally {
      this.scheduledImportRunning = false;
    }
  }

  private async processInventoryPalImport(
    jobId: number,
    options: { daysBack: number; limit: number },
  ): Promise<void> {
    if (!this.hasSyncSourceConfig()) {
      throw new Error('InventoryPal SuppliKit API or DB configuration is missing');
    }

    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.RUNNING,
      startedAt: new Date(),
    });
    await this.markSyncRunning(jobId, options);

    const { rows, domainMap } = await this.loadSyncRows(options);
    const localDomains = await this.domainRepository.find();

    await this.importJobRepository.update(jobId, {
      totalFiles: 1,
      processedFiles: 0,
      totalRecords: rows.length,
    });

    const seenEmailDomains = new Set<string>();
    let processedRecords = 0;
    let importedEmails = 0;
    let duplicateEmails = 0;
    let invalidEmails = 0;
    let customersImported = 0;
    let customersUpdated = 0;
    let emailsLinked = 0;

    for (const row of rows) {
      processedRecords++;

      const email = row.customerEmail?.trim().toLowerCase();
      const sourceIdentifier = `supplikit_order_${row.id}`;
      const intakeDecision = await this.validationIntakeGateService.prepareImportCandidate(
        {
          email: email || '',
          firstName: row.customerFirstName || undefined,
          lastName: row.customerLastName || undefined,
          phone: row.customerPhone || undefined,
          acquisitionSource: 'supplikit_orders',
          acquisitionDate: row.dateCreated ? new Date(row.dateCreated) : new Date(),
          funnelStage: row.status || undefined,
        },
        ImportSourceType.INVENTORYPAL_ORDER,
        sourceIdentifier,
      );

      if (!this.isImportableEmail(email) || !intakeDecision.accepted) {
        invalidEmails++;
        continue;
      }

      const rowDomainKey = `${email}:${row.authorizedDomainId || this.normalizeHost(row.storeUrl || '') || 'unknown'}`;
      if (seenEmailDomains.has(rowDomainKey)) {
        duplicateEmails++;
        continue;
      }

      seenEmailDomains.add(rowDomainKey);

      const existingCustomer = await this.customersService.findByEmail(email);
      if (existingCustomer) {
        customersUpdated++;
      } else {
        customersImported++;
      }

      const address = this.parseAddress(row.billingAddress);
      const localDomain = this.findLocalDomain(row, domainMap, localDomains);
      const paymentMethod = this.mapPaymentMethod(row.paymentMethod);

      const customer = await this.customersService.upsert({
        email,
        firstName: row.customerFirstName || this.readString(address, 'firstName') || this.readString(address, 'first_name'),
        lastName: row.customerLastName || this.readString(address, 'lastName') || this.readString(address, 'last_name'),
        phone: row.customerPhone || this.readString(address, 'phone'),
        company: this.readString(address, 'company'),
        address_1: this.readString(address, 'address1') || this.readString(address, 'address_1'),
        address_2: this.readString(address, 'address2') || this.readString(address, 'address_2'),
        city: this.readString(address, 'city'),
        state: this.readString(address, 'state'),
        postcode: this.readString(address, 'postcode'),
        country: this.readString(address, 'country'),
        preferredPaymentMethod: paymentMethod,
        primaryDomainId: existingCustomer?.primary_domain_id || localDomain?.id,
        woocommerceCustomerId: row.woocommerceOrderId?.toString(),
      });

      if (localDomain) {
        await this.customersService.associateWithDomain(customer.id, localDomain.id, {
          woocommerceCustomerId: row.woocommerceOrderId?.toString(),
          orderCount: Number(row.orderCount || 1),
          totalSpent: Number(row.totalSpent ?? row.total ?? 0),
          firstOrderDate: this.toDate(row.firstOrderDate || row.dateCreated),
          lastOrderDate: this.toDate(row.lastOrderDate || row.dateCreated),
        });
      }

      const emailResult = await this.emailsService.bulkCreate(
        [this.toEmailDto(row, email, localDomain?.domain_name)],
        ImportSourceType.INVENTORYPAL_ORDER,
        sourceIdentifier,
      );

      importedEmails += emailResult.imported;
      duplicateEmails += emailResult.duplicates;
      invalidEmails += emailResult.errors;

      const updateResult = await this.emailRepository.update({ email }, { customerId: customer.id });
      emailsLinked += updateResult.affected || 0;
      await this.validationIntakeGateService.queueValidation(email);

      if (processedRecords % 100 === 0) {
        await this.importJobRepository.update(jobId, {
          processedRecords,
          importedEmails,
          duplicateEmails,
          invalidEmails,
        });
      }
    }

    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.COMPLETED,
      completedAt: new Date(),
      processedFiles: 1,
      processedRecords,
      importedEmails,
      duplicateEmails,
      invalidEmails,
    });
    await this.markSyncSucceeded(jobId, rows, {
      processedRecords,
      importedEmails,
      duplicateEmails,
      invalidEmails,
      options,
    });

    this.logger.log(
      `InventoryPal import job ${jobId} completed: ${customersImported} customers created, ${customersUpdated} updated, ${importedEmails} emails created, ${emailsLinked} linked`,
    );

    await this.runAutomaticRecoverableEmailGate(jobId, options);
  }

  async reconcileStaleImportJobs(thresholdMinutes = this.staleJobThresholdMinutes): Promise<number> {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    const result = await this.importJobRepository
      .createQueryBuilder()
      .update(ImportJob)
      .set({
        status: ImportJobStatus.FAILED,
        completedAt: new Date(),
        errorMessage: `Marked failed automatically: stale import job exceeded ${thresholdMinutes} minutes without completion. The API process was likely restarted or interrupted.`,
      })
      .where('status IN (:...statuses)', {
        statuses: [ImportJobStatus.PENDING, ImportJobStatus.RUNNING],
      })
      .andWhere('COALESCE(startedAt, createdAt) < :cutoff', { cutoff })
      .andWhere('completedAt IS NULL')
      .execute();

    const affected = result.affected || 0;
    if (affected > 0) {
      this.logger.warn(`Marked ${affected} stale import job(s) as failed`);
      await this.markSyncFailed(
        undefined,
        `Marked ${affected} stale import job(s) as failed after exceeding ${thresholdMinutes} minutes`,
      );
    }

    return affected;
  }

  private async getOrCreateSyncState(): Promise<SyncState> {
    const existing = await this.syncStateRepository.findOne({
      where: { syncKey: this.syncKey },
    });

    if (existing) {
      return existing;
    }

    const latestCompletedJob = await this.importJobRepository.findOne({
      where: {
        sourceType: ImportJobSourceType.INVENTORYPAL,
        status: ImportJobStatus.COMPLETED,
      },
      order: { completedAt: 'DESC', createdAt: 'DESC' },
    });

    return this.syncStateRepository.save(
      this.syncStateRepository.create({
        syncKey: this.syncKey,
        sourceType: ImportJobSourceType.INVENTORYPAL,
        status: 'idle',
        lastAttemptedSyncAt: latestCompletedJob?.startedAt || null,
        lastSuccessfulSyncAt: latestCompletedJob?.completedAt || null,
        lastCompletedAt: latestCompletedJob?.completedAt || null,
        lastJobId: latestCompletedJob?.id || null,
        lastRowsSeen: latestCompletedJob?.totalRecords || 0,
        lastImportedEmails: latestCompletedJob?.importedEmails || 0,
        lastDuplicateEmails: latestCompletedJob?.duplicateEmails || 0,
        lastInvalidEmails: latestCompletedJob?.invalidEmails || 0,
        overlapDays: this.getReconciliationOverlapDays(),
        maxRecoveryDays: this.getReconciliationMaxDays(),
        metadata: latestCompletedJob
          ? { bootstrappedFromImportJobId: latestCompletedJob.id }
          : null,
      }),
    );
  }

  private getReconciliationOverlapDays(): number {
    return this.clampNumber(
      this.configService.get<string>('INVENTORYPAL_RECONCILIATION_OVERLAP_DAYS'),
      1,
      30,
      7,
    );
  }

  private getReconciliationMaxDays(): number {
    return this.clampNumber(
      this.configService.get<string>('INVENTORYPAL_RECONCILIATION_MAX_DAYS'),
      7,
      3650,
      365,
    );
  }

  private async getReconciledDaysBack(requestedDaysBack: number): Promise<number> {
    const state = await this.getOrCreateSyncState();
    const overlapDays = this.getReconciliationOverlapDays();
    const maxRecoveryDays = this.getReconciliationMaxDays();

    if (!state.lastSuccessfulSyncAt) {
      return this.clampNumber(requestedDaysBack, 1, maxRecoveryDays, requestedDaysBack);
    }

    const msPerDay = 24 * 60 * 60 * 1000;
    const elapsedDays = Math.max(
      0,
      Math.ceil((Date.now() - new Date(state.lastSuccessfulSyncAt).getTime()) / msPerDay),
    );

    return this.clampNumber(
      Math.max(requestedDaysBack, elapsedDays + overlapDays),
      1,
      maxRecoveryDays,
      requestedDaysBack,
    );
  }

  private async getSyncStateSummary(requestedDaysBack: number): Promise<SyncOverview['syncState']> {
    const state = await this.syncStateRepository.findOne({ where: { syncKey: this.syncKey } });
    const nextDaysBack = await this.getReconciledDaysBack(requestedDaysBack);

    if (!state) {
      return {
        status: 'idle',
        lastAttemptedSyncAt: null,
        lastSuccessfulSyncAt: null,
        lastOrderDate: null,
        lastJobId: null,
        overlapDays: this.getReconciliationOverlapDays(),
        maxRecoveryDays: this.getReconciliationMaxDays(),
        nextDaysBack,
        lastErrorMessage: null,
      };
    }

    return {
      status: state.status,
      lastAttemptedSyncAt: state.lastAttemptedSyncAt || null,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt || null,
      lastOrderDate: state.lastOrderDate || null,
      lastJobId: state.lastJobId || null,
      overlapDays: state.overlapDays || this.getReconciliationOverlapDays(),
      maxRecoveryDays: state.maxRecoveryDays || this.getReconciliationMaxDays(),
      nextDaysBack,
      lastErrorMessage: state.lastErrorMessage || null,
    };
  }

  private async markSyncRunning(
    jobId: number,
    options: { daysBack: number; limit: number },
  ): Promise<void> {
    const state = await this.getOrCreateSyncState();
    await this.syncStateRepository.update(state.id, {
      status: 'running',
      lastAttemptedSyncAt: new Date(),
      lastJobId: jobId,
      overlapDays: this.getReconciliationOverlapDays(),
      maxRecoveryDays: this.getReconciliationMaxDays(),
      lastErrorMessage: null,
      metadata: {
        ...(state.metadata || {}),
        lastRequestedDaysBack: options.daysBack,
        lastRequestedLimit: options.limit,
      },
    });
  }

  private async markSyncSucceeded(
    jobId: number,
    rows: SyncOrderRow[],
    result: {
      processedRecords: number;
      importedEmails: number;
      duplicateEmails: number;
      invalidEmails: number;
      options: { daysBack: number; limit: number };
    },
  ): Promise<void> {
    const state = await this.getOrCreateSyncState();
    const newest = rows.reduce<SyncOrderRow | null>((current, row) => {
      if (!current) {
        return row;
      }

      const currentDate = this.toDate(current.lastOrderDate || current.dateCreated)?.getTime() || 0;
      const rowDate = this.toDate(row.lastOrderDate || row.dateCreated)?.getTime() || 0;

      if (rowDate > currentDate) {
        return row;
      }

      if (rowDate === currentDate && Number(row.id || 0) > Number(current.id || 0)) {
        return row;
      }

      return current;
    }, null);
    const now = new Date();

    await this.syncStateRepository.update(state.id, {
      status: 'idle',
      lastSuccessfulSyncAt: now,
      lastCompletedAt: now,
      lastOrderDate: newest
        ? this.toDate(newest.lastOrderDate || newest.dateCreated) || state.lastOrderDate
        : state.lastOrderDate,
      lastOrderId: newest?.id || state.lastOrderId,
      lastJobId: jobId,
      lastRowsSeen: rows.length,
      lastImportedEmails: result.importedEmails,
      lastDuplicateEmails: result.duplicateEmails,
      lastInvalidEmails: result.invalidEmails,
      overlapDays: this.getReconciliationOverlapDays(),
      maxRecoveryDays: this.getReconciliationMaxDays(),
      lastErrorMessage: null,
      metadata: {
        ...(state.metadata || {}),
        processedRecords: result.processedRecords,
        effectiveDaysBack: result.options.daysBack,
        effectiveLimit: result.options.limit,
      },
    });
  }

  private async markSyncFailed(jobId: number | undefined, errorMessage: string): Promise<void> {
    const state = await this.getOrCreateSyncState();
    await this.syncStateRepository.update(state.id, {
      status: 'failed',
      lastCompletedAt: new Date(),
      lastJobId: jobId || state.lastJobId,
      lastErrorMessage: errorMessage,
      overlapDays: this.getReconciliationOverlapDays(),
      maxRecoveryDays: this.getReconciliationMaxDays(),
    });
  }

  private async runAutomaticRecoverableEmailGate(
    jobId: number,
    options: { daysBack: number; limit: number },
  ): Promise<void> {
    if (this.configService.get<string>('INVENTORYPAL_AUTO_RECOVER_MISSING_EMAILS') === 'false') {
      return;
    }

    try {
      const result = await this.recoverMissingEmailsByPhone({
        daysBack: options.daysBack,
        limit: Math.min(options.limit || 5000, 5000),
        dryRun: false,
      });

      this.logger.log(
        `InventoryPal import job ${jobId} quality gate: recovered ${result.candidates} high-confidence missing emails, skipped ${result.skippedReview} review, ${result.skippedInvalid} invalid/test, ${result.skippedAlreadyRecovered} already recovered`,
      );
    } catch (error) {
      this.logger.warn(
        `InventoryPal import job ${jobId} quality gate recovery skipped: ${error.message}`,
      );
    }
  }

  private createRecoveryResult(query: {
    dryRun: boolean;
    daysBack: number;
    domainId: number;
    limit: number;
  }): RecoverableMissingEmailRecoveryResult {
    return {
      dryRun: query.dryRun,
      daysBack: query.daysBack,
      domainId: query.domainId,
      limit: query.limit,
      candidates: 0,
      skippedReview: 0,
      skippedInvalid: 0,
      skippedAlreadyRecovered: 0,
      customersCreated: 0,
      customersUpdated: 0,
      emailsCreated: 0,
      emailsLinked: 0,
      sourcesCreated: 0,
      duplicateSources: 0,
    };
  }

  private async recoverSingleRow(
    row: RecoverableMissingEmailRow,
    result: RecoverableMissingEmailRecoveryResult,
    dryRun: boolean,
    localDomains: Domain[],
    requireSingleCandidateEmail: boolean,
  ): Promise<void> {
    if (row.alreadyRecovered) {
      result.skippedAlreadyRecovered++;
      return;
    }

    const email = row.candidateEmail?.trim().toLowerCase();
    const name = this.splitName(row.customerName || row.candidateName);
    const sourceIdentifier = this.getRecoveredSourceIdentifier(row);

    const recoveredEmailData = {
      email: email || '',
      firstName: name.firstName,
      lastName: name.lastName,
      phone: row.phone || row.normalizedPhone,
      acquisitionSource: this.getRecoveredAcquisitionSource(row),
      acquisitionDate: row.orderDate || new Date(),
      funnelStage: row.status || undefined,
    };
    const intakeDecision = dryRun
      ? await this.validationIntakeGateService.evaluate(email)
      : await this.validationIntakeGateService.prepareImportCandidate(
          recoveredEmailData,
          ImportSourceType.INVENTORYPAL_ORDER,
          sourceIdentifier,
        );

    if (
      !this.isImportableEmail(email) ||
      (requireSingleCandidateEmail && row.candidateEmailsForPhone !== 1) ||
      !intakeDecision.accepted
    ) {
      result.skippedInvalid++;
      return;
    }

    result.candidates++;
    const existingCustomer = await this.customersService.findByEmail(email);
    const existingEmail = await this.emailRepository.findOne({ where: { email } });
    const localDomain = this.findLocalDomain(
      {
        authorizedDomainId: row.authorizedDomainId,
        storeUrl: row.storeUrl,
      } as SyncOrderRow,
      new Map([[row.authorizedDomainId, row.storeUrl || '']]),
      localDomains,
    );
    const existingSource = existingEmail
      ? await this.emailSourceRepository.findOne({
          where: {
            emailId: existingEmail.id,
            sourceType: ImportSourceType.INVENTORYPAL_ORDER,
            sourceIdentifier,
          },
        })
      : null;

    if (!existingCustomer) {
      result.customersCreated++;
    } else {
      result.customersUpdated++;
    }

    if (!existingEmail) {
      result.emailsCreated++;
    }

    if (!existingEmail?.customerId || existingEmail.customerId !== existingCustomer?.id) {
      result.emailsLinked++;
    }

    if (existingSource) {
      result.duplicateSources++;
    } else {
      result.sourcesCreated++;
    }

    if (dryRun) {
      return;
    }

    const customer = await this.customersService.upsert({
      email,
      firstName: name.firstName,
      lastName: name.lastName,
      phone: row.phone || row.normalizedPhone,
      primaryDomainId: existingCustomer?.primary_domain_id || localDomain?.id,
    });

    const savedEmail =
      existingEmail ||
      (await this.emailRepository.save(
        this.emailRepository.create({
          email,
          emailDomain: email.split('@')[1] || null,
          customerId: customer.id,
          firstName: name.firstName,
          lastName: name.lastName,
          phone: row.phone || row.normalizedPhone,
          acquisitionSource: this.getRecoveredAcquisitionSource(row),
          acquisitionDate: row.orderDate || new Date(),
          funnelStage: row.status || undefined,
          ...this.sendEligibilityService.buildUpdate({
            verificationStatus: VerificationStatus.PENDING,
            qualityScore: 0,
          }),
        }),
      ));

    if (savedEmail.customerId !== customer.id) {
      await this.emailRepository.update(savedEmail.id, {
        customerId: customer.id,
        ...this.sendEligibilityService.buildUpdate({
          verificationStatus: savedEmail.verificationStatus,
          qualityScore: Number(savedEmail.qualityScore || 0),
          gmailCategory: savedEmail.gmailCategory,
          hasTypo: savedEmail.hasTypo,
          typoResolutionStatus: savedEmail.typoResolutionStatus,
          isDisposable: savedEmail.isDisposable,
          isRoleBased: savedEmail.isRoleBased,
          hasValidSyntax: savedEmail.hasValidSyntax,
          hasValidDns: savedEmail.hasValidDns,
          hasValidSmtp: savedEmail.hasValidSmtp,
        }),
      });
    }

    if (!existingSource) {
      await this.emailSourceRepository.save({
        emailId: savedEmail.id,
        sourceType: ImportSourceType.INVENTORYPAL_ORDER,
        sourceIdentifier,
        consentGiven: true,
        consentTimestamp: row.orderDate || new Date(),
      });
    }

    await this.validationIntakeGateService.queueValidation(email);
  }

  private async loadSyncRows(options: { daysBack: number; limit: number }): Promise<{
    rows: SyncOrderRow[];
    domainMap: Map<number, string>;
  }> {
    if (this.hasApiConfig()) {
      const rows = await this.fetchRowsFromApi(options);
      return {
        rows,
        domainMap: new Map(rows.map((row) => [Number(row.authorizedDomainId), String(row.storeUrl || '')])),
      };
    }

    const connection = await this.createSyncConnection();
    try {
      return {
        rows: await this.fetchRecentOrders(connection, options),
        domainMap: await this.getDomainMap(connection),
      };
    } finally {
      await connection.end();
    }
  }

  private async fetchRecentOrders(
    connection: Connection,
    options: { daysBack: number; limit: number },
  ): Promise<SyncOrderRow[]> {
    const [rows] = await connection.query(
      `
        SELECT
          latest.id,
          latest.authorizedDomainId,
          ad.store_url AS storeUrl,
          ad.store_name AS storeName,
          ad.platform AS platform,
          latest.woocommerceOrderId,
          latest.orderNumber,
          latest.status,
          latest.total,
          aggregateRows.orderCount,
          aggregateRows.totalSpent,
          latest.customerEmail,
          latest.customerPhone,
          latest.customerFirstName,
          latest.customerLastName,
          latest.paymentMethod,
          latest.billingAddress,
          latest.dateCreated,
          aggregateRows.firstOrderDate,
          aggregateRows.lastOrderDate
        FROM (
          SELECT
            LOWER(TRIM(customerEmail)) AS normalizedEmail,
            authorizedDomainId,
            MAX(id) AS latestOrderId,
            COUNT(*) AS orderCount,
            SUM(CAST(total AS DECIMAL(12,2))) AS totalSpent,
            MIN(dateCreated) AS firstOrderDate,
            MAX(dateCreated) AS lastOrderDate
          FROM \`order\`
          WHERE orderType = 'order'
            AND customerEmail IS NOT NULL
            AND customerEmail != ''
            AND dateCreated >= DATE_SUB(NOW(), INTERVAL ? DAY)
          GROUP BY LOWER(TRIM(customerEmail)), authorizedDomainId
        ) aggregateRows
        INNER JOIN \`order\` latest ON latest.id = aggregateRows.latestOrderId
        LEFT JOIN authorized_domains ad ON ad.id = latest.authorizedDomainId
        ORDER BY aggregateRows.lastOrderDate DESC
        LIMIT ?
      `,
      [options.daysBack, options.limit],
    );

    return rows as SyncOrderRow[];
  }

  private async getDomainMap(connection: Connection): Promise<Map<number, string>> {
    const [rows] = await connection.query('SELECT id, store_url FROM authorized_domains');
    return new Map((rows as any[]).map((row) => [Number(row.id), String(row.store_url || '')]));
  }

  private async getApiOverview(daysBack: number): Promise<SyncOverview> {
    const endpoint = new URL(`${this.getApiBaseUrl()}/customers/overview`);
    endpoint.searchParams.set('daysBack', String(daysBack));

    const payload = await this.requestSuppliKitApi(endpoint);
    const overview = payload.overview || payload.data || payload;

    return {
      configured: true,
      autoImportEnabled: this.isAutoImportEnabled(),
      source: 'api',
      recentOrders: Number(overview.recentOrders || overview.recentOrderCount || 0),
      uniqueEmails: Number(overview.uniqueEmails || overview.uniqueCustomerEmails || 0),
      newestOrderDate: overview.newestOrderDate ? new Date(overview.newestOrderDate) : null,
    };
  }

  private async getApiRecoverableMissingEmails(query: {
    daysBack: number;
    limit: number;
    domainId: number;
  }): Promise<RecoverableMissingEmailAudit> {
    const endpoint = new URL(`${this.getApiBaseUrl()}/customers/recoverable-missing-emails`);
    endpoint.searchParams.set('daysBack', String(query.daysBack));
    endpoint.searchParams.set('limit', String(query.limit));
    if (query.domainId > 0) {
      endpoint.searchParams.set('domainId', String(query.domainId));
    }

    const payload = await this.requestSuppliKitApi(endpoint);
    const audit = payload.audit || payload.data || payload;

    return {
      configured: true,
      source: 'api',
      daysBack: Number(audit.daysBack || query.daysBack),
      totalMissingEmailOrders: Number(audit.totalMissingEmailOrders || 0),
      missingWithPhoneOrders: Number(audit.missingWithPhoneOrders || 0),
      recoverableOrders: Number(audit.recoverableOrders || 0),
      uniqueRecoverablePhones: Number(audit.uniqueRecoverablePhones || 0),
      ambiguousPhones: Number(audit.ambiguousPhones || 0),
      alreadyRecoveredOrders: Number(audit.alreadyRecoveredOrders || 0),
      rows: this.extractApiRecoverableRows(audit.rows || audit.recoverable || []),
    };
  }

  private async getDbRecoverableMissingEmails(
    connection: Connection,
    query: { daysBack: number; limit: number; domainId: number },
  ): Promise<RecoverableMissingEmailAudit> {
    const domainFilter = query.domainId > 0 ? 'AND o.authorizedDomainId = ?' : '';
    const candidateDomainFilter = query.domainId > 0 ? 'AND o.authorizedDomainId = ?' : '';
    const params: Array<number> = [query.daysBack];
    const candidateParams: Array<number> = [];

    if (query.domainId > 0) {
      params.push(query.domainId);
      candidateParams.push(query.domainId);
    }

    const [summaryRows] = await connection.query(
      `
        SELECT
          COUNT(*) AS totalMissingEmailOrders,
          SUM(CASE WHEN o.customerPhone IS NOT NULL AND TRIM(o.customerPhone) != '' THEN 1 ELSE 0 END) AS missingWithPhoneOrders
        FROM \`order\` o
        WHERE o.orderType = 'order'
          AND NOT (${this.importableEmailWhereForAlias('o')})
          AND o.dateCreated >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ${domainFilter}
      `,
      params,
    );

    const [missingRows] = await connection.query(
      `
        SELECT
          o.id,
          o.authorizedDomainId,
          ad.store_url AS storeUrl,
          ad.store_name AS storeName,
          o.orderNumber,
          o.status,
          o.customerPhone,
          o.customerFirstName,
          o.customerLastName,
          o.dateCreated
        FROM \`order\` o
        LEFT JOIN authorized_domains ad ON ad.id = o.authorizedDomainId
        WHERE o.orderType = 'order'
          AND NOT (${this.importableEmailWhereForAlias('o')})
          AND o.customerPhone IS NOT NULL
          AND TRIM(o.customerPhone) != ''
          AND o.dateCreated >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ${domainFilter}
        ORDER BY o.dateCreated DESC
        LIMIT ?
      `,
      [...params, 25000],
    );

    const [candidateRows] = await connection.query(
      `
        SELECT
          o.id,
          o.authorizedDomainId,
          ad.store_url AS storeUrl,
          ad.store_name AS storeName,
          o.customerEmail,
          o.customerPhone,
          o.customerFirstName,
          o.customerLastName,
          o.dateCreated
        FROM \`order\` o
        LEFT JOIN authorized_domains ad ON ad.id = o.authorizedDomainId
        WHERE o.orderType = 'order'
          AND ${this.importableEmailWhereForAlias('o')}
          AND o.customerPhone IS NOT NULL
          AND TRIM(o.customerPhone) != ''
          ${candidateDomainFilter}
        ORDER BY o.dateCreated DESC
        LIMIT 200000
      `,
      candidateParams,
    );

    const candidatesByPhone = this.groupRecoverableCandidates(candidateRows as any[]);
    const rows: RecoverableMissingEmailRow[] = [];
    const recoverablePhones = new Set<string>();
    const ambiguousPhones = new Set<string>();
    let recoverableOrders = 0;

    for (const missing of missingRows as any[]) {
      const normalizedPhone = this.normalizePhone(missing.customerPhone);
      if (!normalizedPhone) {
        continue;
      }

      const candidates = candidatesByPhone.get(normalizedPhone);
      if (!candidates?.length) {
        continue;
      }

      const emails = new Set(candidates.map((candidate) => candidate.email));
      const bestCandidate = candidates[0];
      const confidence = emails.size === 1 ? 'high' : 'review';

      recoverablePhones.add(normalizedPhone);
      recoverableOrders++;
      if (emails.size > 1) {
        ambiguousPhones.add(normalizedPhone);
      }

      if (rows.length < query.limit) {
        rows.push({
          orderId: Number(missing.id || 0),
          authorizedDomainId: Number(missing.authorizedDomainId || 0),
          storeUrl: missing.storeUrl || null,
          storeName: missing.storeName || null,
          orderNumber: String(missing.orderNumber || ''),
          status: String(missing.status || ''),
          orderDate: this.toDate(missing.dateCreated) || null,
          phone: String(missing.customerPhone || ''),
          normalizedPhone,
          customerName: this.formatName(missing.customerFirstName, missing.customerLastName),
          candidateEmail: bestCandidate.email,
          candidateName: bestCandidate.name,
          candidateOrderId: bestCandidate.orderId,
          candidateOrderDate: bestCandidate.orderDate,
          candidateDomainId: bestCandidate.domainId,
          candidateStoreUrl: bestCandidate.storeUrl,
          candidateStoreName: bestCandidate.storeName,
          confidence,
          candidateEmailsForPhone: emails.size,
          candidateOrdersForPhone: candidates.length,
          alreadyRecovered: false,
          candidateEmailInList: false,
          candidateEmailStatus: null,
        });
      }
    }

    const summary = (summaryRows as any[])[0] || {};
    return {
      configured: true,
      source: 'database',
      daysBack: query.daysBack,
      totalMissingEmailOrders: Number(summary.totalMissingEmailOrders || 0),
      missingWithPhoneOrders: Number(summary.missingWithPhoneOrders || 0),
      recoverableOrders,
      uniqueRecoverablePhones: recoverablePhones.size,
      ambiguousPhones: ambiguousPhones.size,
      alreadyRecoveredOrders: 0,
      rows,
    };
  }

  private async enrichRecoverableMissingEmailAudit(
    audit: RecoverableMissingEmailAudit,
  ): Promise<RecoverableMissingEmailAudit> {
    if (!audit.rows.length) {
      return {
        ...audit,
        alreadyRecoveredOrders: 0,
      };
    }

    const localDomains = await this.domainRepository.find();
    const mappedRows = this.applyRecoverableDomainMapping(audit.rows, localDomains);
    const sourceIdentifiers = mappedRows.map((row) => this.getRecoveredSourceIdentifier(row));
    const candidateEmails = Array.from(
      new Set(
        mappedRows
          .map((row) => row.candidateEmail?.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    const recoveredSources = await this.emailSourceRepository.find({
      where: {
        sourceType: ImportSourceType.INVENTORYPAL_ORDER,
        sourceIdentifier: In(sourceIdentifiers),
      },
    });
    const existingEmails = candidateEmails.length
      ? await this.emailRepository.find({ where: { email: In(candidateEmails) } })
      : [];
    const recoveredSourceIdentifiers = new Set(
      recoveredSources.map((source) => source.sourceIdentifier).filter(Boolean),
    );
    const existingEmailsByAddress = new Map(existingEmails.map((email) => [email.email, email]));

    const rows = mappedRows.map((row) => ({
      ...row,
      candidateEmailInList: existingEmailsByAddress.has(row.candidateEmail?.trim().toLowerCase()),
      candidateEmailStatus: existingEmailsByAddress.get(row.candidateEmail?.trim().toLowerCase())?.verificationStatus || null,
      alreadyRecovered: recoveredSourceIdentifiers.has(this.getRecoveredSourceIdentifier(row)),
    }));

    return {
      ...audit,
      alreadyRecoveredOrders: rows.filter((row) => row.alreadyRecovered).length,
      rows,
    };
  }

  private async fetchRowsFromApi(options: { daysBack: number; limit: number }): Promise<SyncOrderRow[]> {
    const rows: SyncOrderRow[] = [];
    const pageSize = Math.min(options.limit, 1000);
    let offset = 0;
    let hasMore = true;

    while (rows.length < options.limit && hasMore) {
      const endpoint = new URL(`${this.getApiBaseUrl()}/customers`);
      endpoint.searchParams.set('daysBack', String(options.daysBack));
      endpoint.searchParams.set('limit', String(Math.min(pageSize, options.limit - rows.length)));
      endpoint.searchParams.set('offset', String(offset));

      const payload = await this.requestSuppliKitApi(endpoint);
      const batch = this.extractApiCustomers(payload).map((row) => this.mapApiCustomerRow(row));

      rows.push(...batch);
      offset += batch.length;

      const pagination = payload.pagination || payload.meta || {};
      hasMore = Boolean(pagination.hasMore ?? pagination.nextOffset ?? batch.length === pageSize);
      if (!batch.length) {
        hasMore = false;
      }
    }

    return rows;
  }

  private extractApiCustomers(payload: any): any[] {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (Array.isArray(payload.customers)) {
      return payload.customers;
    }

    if (Array.isArray(payload.data)) {
      return payload.data;
    }

    return [];
  }

  private extractApiRecoverableRows(rows: any[]): RecoverableMissingEmailRow[] {
    if (!Array.isArray(rows)) {
      return [];
    }

    return rows.map((row) => ({
      orderId: Number(row.orderId || row.id || 0),
      authorizedDomainId: Number(row.authorizedDomainId || row.domainId || 0),
      storeUrl: row.storeUrl || null,
      storeName: row.storeName || null,
      orderNumber: String(row.orderNumber || ''),
      status: String(row.status || ''),
      orderDate: row.orderDate ? new Date(row.orderDate) : null,
      phone: String(row.phone || ''),
      normalizedPhone: String(row.normalizedPhone || this.normalizePhone(row.phone)),
      customerName: String(row.customerName || ''),
      candidateEmail: String(row.candidateEmail || row.email || ''),
      candidateName: String(row.candidateName || ''),
      candidateOrderId: Number(row.candidateOrderId || row.lastOrderId || 0),
      candidateOrderDate: row.candidateOrderDate ? new Date(row.candidateOrderDate) : null,
      candidateDomainId: Number(row.candidateDomainId || 0),
      candidateStoreUrl: row.candidateStoreUrl || null,
      candidateStoreName: row.candidateStoreName || null,
      confidence: row.confidence === 'review' ? 'review' : 'high',
      candidateEmailsForPhone: Number(row.candidateEmailsForPhone || 1),
      candidateOrdersForPhone: Number(row.candidateOrdersForPhone || 1),
      alreadyRecovered: Boolean(row.alreadyRecovered),
      candidateEmailInList: Boolean(row.candidateEmailInList),
      candidateEmailStatus: row.candidateEmailStatus || null,
    }));
  }

  private mapApiCustomerRow(row: any): SyncOrderRow {
    return {
      id: Number(row.id || row.lastOrderId || row.latestOrderId || 0),
      authorizedDomainId: Number(row.authorizedDomainId || row.domainId || 0),
      storeUrl: row.storeUrl || row.sourceDomain || row.domain?.storeUrl || null,
      storeName: row.storeName || row.domain?.storeName || null,
      platform: row.platform || row.domain?.platform || null,
      woocommerceOrderId: Number(row.woocommerceOrderId || row.lastWooCommerceOrderId || row.lastOrderExternalId || 0),
      orderNumber: String(row.orderNumber || row.lastOrderNumber || ''),
      status: String(row.status || row.lastOrderStatus || ''),
      total: row.total || row.lastOrderTotal || 0,
      orderCount: Number(row.orderCount || 1),
      totalSpent: row.totalSpent || row.total || 0,
      customerEmail: String(row.customerEmail || row.email || ''),
      customerPhone: row.customerPhone || row.phone || null,
      customerFirstName: row.customerFirstName || row.firstName || null,
      customerLastName: row.customerLastName || row.lastName || null,
      paymentMethod: row.paymentMethod || row.lastPaymentMethod || null,
      billingAddress: row.billingAddress || row.billing || null,
      dateCreated: row.lastOrderDate || row.dateCreated || row.createdAt || new Date(),
      firstOrderDate: row.firstOrderDate || null,
      lastOrderDate: row.lastOrderDate || row.dateCreated || null,
    };
  }

  private async requestSuppliKitApi(endpoint: URL): Promise<any> {
    const token = this.configService.get<string>('INVENTORYPAL_SYNC_API_TOKEN');
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-inventorypal-service-token': token || '',
      },
    });

    if (!response.ok) {
      throw new Error(`SuppliKit API request failed with ${response.status}`);
    }

    return response.json();
  }

  private getApiBaseUrl(): string {
    const configured = this.configService.get<string>('INVENTORYPAL_SYNC_API_URL') || '';
    return configured.replace(/\/+$/, '');
  }

  private findLocalDomain(
    order: SyncOrderRow,
    domainMap: Map<number, string>,
    localDomains: Domain[],
  ): Domain | null {
    const sourceUrl = order.storeUrl || domainMap.get(Number(order.authorizedDomainId)) || '';
    const sourceHost = this.normalizeHost(sourceUrl) || this.normalizeHost(order.storeName || '');

    if (!sourceHost) {
      return this.findLocalDomainBySource('', order.storeName, localDomains);
    }

    return this.findLocalDomainBySource(sourceHost, order.storeName, localDomains);
  }

  private toEmailDto(row: SyncOrderRow, email: string, domainName?: string): CreateEmailDto {
    return {
      email,
      firstName: row.customerFirstName || undefined,
      lastName: row.customerLastName || undefined,
      phone: row.customerPhone || undefined,
      acquisitionSource: domainName ? `supplikit_${domainName}` : 'supplikit_orders',
      acquisitionDate: row.dateCreated ? new Date(row.dateCreated) : new Date(),
      funnelStage: row.status || undefined,
    };
  }

  private createSyncConnection(): Promise<Connection> {
    return createConnection({
      host: this.configService.get<string>('INVENTORYPAL_DB_HOST'),
      port: Number(this.configService.get<string>('INVENTORYPAL_DB_PORT') || 3306),
      user: this.configService.get<string>('INVENTORYPAL_DB_USERNAME'),
      password: this.configService.get<string>('INVENTORYPAL_DB_PASSWORD'),
      database: this.configService.get<string>('INVENTORYPAL_DB_DATABASE'),
    });
  }

  private hasSyncSourceConfig(): boolean {
    return this.hasApiConfig() || this.hasConnectionConfig();
  }

  private hasApiConfig(): boolean {
    return Boolean(
      this.configService.get<string>('INVENTORYPAL_SYNC_API_URL') &&
      this.configService.get<string>('INVENTORYPAL_SYNC_API_TOKEN'),
    );
  }

  private hasConnectionConfig(): boolean {
    return Boolean(
      this.configService.get<string>('INVENTORYPAL_DB_HOST') &&
      this.configService.get<string>('INVENTORYPAL_DB_USERNAME') &&
      this.configService.get<string>('INVENTORYPAL_DB_DATABASE'),
    );
  }

  private parseAddress(value: string | Record<string, unknown> | null): Record<string, unknown> | null {
    if (!value) {
      return null;
    }

    if (typeof value === 'object') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private readString(value: Record<string, unknown> | null, key: string): string | undefined {
    const candidate = value?.[key];
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  }

  private mapPaymentMethod(paymentMethod: string | null): PaymentMethod {
    const normalized = String(paymentMethod || '').toLowerCase();
    if (normalized.includes('cod') || normalized.includes('cash')) {
      return PaymentMethod.CASH_ON_DELIVERY;
    }

    if (normalized.includes('card') || normalized.includes('stripe') || normalized.includes('shopify')) {
      return PaymentMethod.CARD;
    }

    if (normalized.includes('bank') || normalized.includes('transfer')) {
      return PaymentMethod.BANK_TRANSFER;
    }

    return PaymentMethod.UNKNOWN;
  }

  private isImportableEmail(email: string | null | undefined): email is string {
    if (!email || !email.includes('@')) {
      return false;
    }

    const normalized = email.trim().toLowerCase();
    if (
      normalized.startsWith('noemail@') ||
      normalized.startsWith('no-email@') ||
      normalized.startsWith('no_email@') ||
      normalized.startsWith('unknown@')
    ) {
      return false;
    }

    if (
      normalized === 'test@example.com' ||
      normalized === 'client@example.com' ||
      normalized === 'example@example.com' ||
      /^test(\+[^@]+)?@example\./.test(normalized)
    ) {
      return false;
    }

    return true;
  }

  private importableEmailWhereForAlias(alias: string): string {
    const field = `${alias}.customerEmail`;
    return `
      ${field} IS NOT NULL
      AND ${field} != ''
      AND ${field} LIKE '%@%'
      AND LOWER(TRIM(${field})) NOT LIKE 'noemail@%'
      AND LOWER(TRIM(${field})) NOT LIKE 'no-email@%'
      AND LOWER(TRIM(${field})) NOT LIKE 'no_email@%'
      AND LOWER(TRIM(${field})) NOT LIKE 'unknown@%'
      AND LOWER(TRIM(${field})) NOT LIKE 'test%@example.%'
      AND LOWER(TRIM(${field})) NOT IN ('test@example.com', 'client@example.com', 'example@example.com')
    `;
  }

  private groupRecoverableCandidates(rows: any[]): Map<string, Array<{
    email: string;
    name: string;
    orderId: number;
    orderDate: Date | null;
    domainId: number;
    storeUrl: string | null;
    storeName: string | null;
  }>> {
    const byPhone = new Map<string, Array<{
      email: string;
      name: string;
      orderId: number;
      orderDate: Date | null;
      domainId: number;
      storeUrl: string | null;
      storeName: string | null;
    }>>();

    for (const row of rows) {
      const normalizedPhone = this.normalizePhone(row.customerPhone);
      const email = String(row.customerEmail || '').trim().toLowerCase();
      if (!normalizedPhone || !this.isImportableEmail(email)) {
        continue;
      }

      const candidates = byPhone.get(normalizedPhone) || [];
      candidates.push({
        email,
        name: this.formatName(row.customerFirstName, row.customerLastName),
        orderId: Number(row.id || 0),
        orderDate: this.toDate(row.dateCreated) || null,
        domainId: Number(row.authorizedDomainId || 0),
        storeUrl: row.storeUrl || null,
        storeName: row.storeName || null,
      });
      byPhone.set(normalizedPhone, candidates);
    }

    return byPhone;
  }

  private normalizePhone(value: unknown): string {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 7) {
      return '';
    }

    if (digits.startsWith('0040') && digits.length > 10) {
      return `0${digits.slice(4)}`;
    }

    if (digits.startsWith('40') && digits.length > 9) {
      return `0${digits.slice(2)}`;
    }

    return digits;
  }

  private formatName(firstName: unknown, lastName: unknown): string {
    return [firstName, lastName]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  private splitName(value: string): { firstName?: string; lastName?: string } {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return {};
    }

    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' ') || undefined,
    };
  }

  private getRecoveredSourceIdentifier(row: RecoverableMissingEmailRow): string {
    return `supplikit_recovered_by_phone_order_${row.orderId}_candidate_${row.candidateOrderId}`;
  }

  private getRecoveredAcquisitionSource(row: RecoverableMissingEmailRow): string {
    const domain = row.storeName || this.normalizeHost(row.storeUrl || '') || `domain_${row.authorizedDomainId || 'unknown'}`;
    return `supplikit_recovered_by_phone_${domain}`;
  }

  private toDate(value: string | Date | null | undefined): Date | undefined {
    if (!value) {
      return undefined;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private normalizeHost(value: string): string {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
      return '';
    }

    try {
      return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
    } catch {
      return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  private applyRecoverableDomainMapping(
    rows: RecoverableMissingEmailRow[],
    localDomains: Domain[],
  ): RecoverableMissingEmailRow[] {
    return rows.map((row) => {
      const orderDomainId =
        row.authorizedDomainId ||
        this.findLocalDomainBySource(row.storeUrl || '', row.storeName, localDomains)?.id ||
        0;
      const candidateDomainId =
        row.candidateDomainId ||
        this.findLocalDomainBySource(row.candidateStoreUrl || '', row.candidateStoreName, localDomains)?.id ||
        0;

      return {
        ...row,
        authorizedDomainId: Number(orderDomainId || 0),
        candidateDomainId: Number(candidateDomainId || 0),
      };
    });
  }

  private findLocalDomainBySource(
    sourceUrlOrHost: string,
    sourceName: string | null | undefined,
    localDomains: Domain[],
  ): Domain | null {
    const sourceHost = this.normalizeHost(sourceUrlOrHost);
    const sourceLabel = this.normalizeDomainLabel(sourceName || sourceUrlOrHost);

    return localDomains.find((domain) => {
      const domainHost = this.normalizeHost(domain.domain_name);
      const displayHost = this.normalizeHost(domain.display_name);
      const domainLabel = this.normalizeDomainLabel(domain.domain_name);
      const displayLabel = this.normalizeDomainLabel(domain.display_name);

      return (
        (sourceHost && (sourceHost === domainHost || sourceHost === displayHost)) ||
        (sourceLabel && (sourceLabel === domainLabel || sourceLabel === displayLabel))
      );
    }) || null;
  }

  private normalizeDomainLabel(value: string | null | undefined): string {
    const host = this.normalizeHost(value || '');
    return host
      .replace(/\.(ro|com|net|org|eu)$/i, '')
      .replace(/[^a-z0-9]/g, '');
  }

  private isAutoImportEnabled(): boolean {
    return this.configService.get<string>('INVENTORYPAL_AUTO_IMPORT_ENABLED') === 'true';
  }

  private findActiveInventoryPalJob(): Promise<ImportJob | null> {
    return this.importJobRepository.findOne({
      where: {
        sourceType: ImportJobSourceType.INVENTORYPAL,
        status: In([ImportJobStatus.PENDING, ImportJobStatus.RUNNING]),
      },
      order: { createdAt: 'DESC' },
    });
  }

  private clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return Math.min(Math.max(Math.trunc(parsed), min), max);
  }

  private async markJobFailed(jobId: number, errorMessage: string): Promise<void> {
    await this.importJobRepository.update(jobId, {
      status: ImportJobStatus.FAILED,
      completedAt: new Date(),
      errorMessage,
    });
  }
}
