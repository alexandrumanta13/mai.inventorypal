import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

interface ImportJob {
  id: number;
  sourceType: string;
  status: string;
  importedEmails: number;
  duplicateEmails: number;
  invalidEmails?: number;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
}

interface ImportOverview {
  configured: boolean;
  autoImportEnabled: boolean;
  recentOrders: number;
  uniqueEmails: number;
  newestOrderDate: string | null;
  syncState?: {
    status: string;
    lastAttemptedSyncAt: string | null;
    lastSuccessfulSyncAt: string | null;
    lastOrderDate: string | null;
    lastJobId: number | null;
    overlapDays: number;
    maxRecoveryDays: number;
    nextDaysBack: number;
    lastErrorMessage: string | null;
  };
}

interface RecoverableMissingEmailRow {
  orderId: number;
  authorizedDomainId: number;
  storeUrl: string | null;
  storeName: string | null;
  orderNumber: string;
  status: string;
  orderDate: string | null;
  phone: string;
  normalizedPhone: string;
  customerName: string;
  candidateEmail: string;
  candidateName: string;
  candidateOrderId: number;
  candidateOrderDate: string | null;
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

interface RecoverableMissingEmailAudit {
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

interface RecoverableRecoveryResult {
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

interface Domain {
  id: number;
  domain_name: string;
  display_name: string;
  is_active: boolean;
}

type RecoverableQueue = 'review' | 'auto' | 'ignored' | 'all';

@Component({
  selector: 'app-import',
  standalone: false,
  templateUrl: './import.component.html',
  styleUrls: ['./import.component.scss']
})
export class ImportComponent implements OnInit {
  jobs: ImportJob[] = [];
  domains: Domain[] = [];
  overview: ImportOverview = {
    configured: false,
    autoImportEnabled: false,
    recentOrders: 0,
    uniqueEmails: 0,
    newestOrderDate: null,
  };
  recoverableAudit: RecoverableMissingEmailAudit = this.createEmptyRecoverableAudit();

  daysBack = 7;
  limit = 5000;
  recoverableDaysBack = 365;
  recoverableLimit = 5000;
  recoverableDomainId = '';
  recoverableConfidenceFilter: '' | 'high' | 'review' = '';
  recoverableSearchTerm = '';
  recoverableQueue: RecoverableQueue = 'review';
  selectedDomainId = '';
  loading = true;
  recoverableLoading = false;
  recoverableRecoveryLoading = '';
  recoverableRowActionLoading = '';
  recoverableRecoveryResult: RecoverableRecoveryResult | null = null;
  actionLoading = '';
  errorMessage = '';
  actionMessage = '';

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.refreshImportPage();
  }

  refreshImportPage() {
    this.loadImportDashboard();
    this.loadRecoverableAudit();
  }

  loadImportDashboard() {
    this.loading = true;
    this.errorMessage = '';

    forkJoin({
      jobs: this.http.get<any>('/api/imports/jobs').pipe(catchError(() => of({ jobs: [] }))),
      domains: this.http.get<Domain[]>('/api/domains?active=true').pipe(catchError(() => of([]))),
      overview: this.http
        .get<any>(`/api/imports/inventorypal/overview?daysBack=${this.daysBack}`)
        .pipe(catchError(() => of({ overview: this.overview }))),
    }).subscribe({
      next: ({ jobs, domains, overview }) => {
        this.jobs = jobs.jobs || [];
        this.domains = domains || [];
        this.overview = overview.overview || this.overview;
        this.loading = false;
      },
      error: () => {
        this.errorMessage = 'Import data could not be loaded.';
        this.loading = false;
      }
    });
  }

  loadRecoverableAudit() {
    this.recoverableLoading = true;
    this.errorMessage = '';

    this.http.get<any>(this.getRecoverableAuditUrl()).subscribe({
      next: (response) => {
        this.recoverableAudit = response.audit || this.createEmptyRecoverableAudit();
        this.recoverableLoading = false;
      },
      error: () => {
        this.errorMessage = 'Recoverable missing email audit could not be loaded.';
        this.recoverableLoading = false;
      }
    });
  }

  startInventoryPalImport() {
    const effectiveDaysBack = this.getEffectiveSuppliKitDaysBack();
    const windowLabel = effectiveDaysBack > Number(this.daysBack)
      ? `${effectiveDaysBack} days catch-up window`
      : `last ${this.daysBack} days`;

    if (!confirm(`Import customers from SuppliKit orders from the ${windowLabel}?`)) {
      return;
    }

    this.startAction('inventorypal', '/api/imports/inventorypal', {
      daysBack: Number(this.daysBack),
      limit: Number(this.limit),
    });
  }

  startWooCommerceImport() {
    const endpoint = this.selectedDomainId
      ? `/api/imports/woocommerce/${this.selectedDomainId}`
      : '/api/imports/woocommerce';

    const label = this.selectedDomainId ? 'selected WooCommerce domain' : 'all active WooCommerce domains';
    if (!confirm(`Start import from ${label}?`)) {
      return;
    }

    this.startAction('woocommerce', endpoint, {});
  }

  startCsvImport() {
    if (!confirm('Start CSV import from the configured server path?')) {
      return;
    }

    this.startAction('csv', '/api/imports/csv', {});
  }

  startJsonImport() {
    if (!confirm('Start JSON pages import from the configured server path?')) {
      return;
    }

    this.startAction('json', '/api/imports/json-pages', {});
  }

  trackJob(_: number, job: ImportJob): number {
    return job.id;
  }

  trackRecoverableRow(_: number, row: RecoverableMissingEmailRow): number {
    return row.orderId;
  }

  getFilteredRecoverableRows(): RecoverableMissingEmailRow[] {
    const searchTerm = this.recoverableSearchTerm.trim().toLowerCase();

    return this.recoverableAudit.rows.filter((row) => {
      if (!this.matchesRecoverableQueue(row)) {
        return false;
      }

      if (this.recoverableConfidenceFilter && row.confidence !== this.recoverableConfidenceFilter) {
        return false;
      }

      if (!searchTerm) {
        return true;
      }

      return [
        row.orderNumber,
        row.customerName,
        row.phone,
        row.normalizedPhone,
        row.candidateEmail,
        row.candidateName,
        this.getDomainLabel(row),
        this.getCandidateDomainLabel(row),
      ].some((value) => String(value || '').toLowerCase().includes(searchTerm));
    });
  }

  getLoadedRecoverableRowsCount(): number {
    return this.recoverableAudit.rows.length;
  }

  isRecoverableAuditPartial(): boolean {
    return this.recoverableAudit.recoverableOrders > this.recoverableAudit.rows.length;
  }

  getHighConfidenceRowsCount(): number {
    return this.recoverableAudit.rows.filter((row) => row.confidence === 'high').length;
  }

  getReviewRowsCount(): number {
    return this.recoverableAudit.rows.filter((row) => row.confidence === 'review').length;
  }

  getAutoQueueRowsCount(): number {
    return this.recoverableAudit.rows.filter((row) => row.confidence === 'high' || row.alreadyRecovered).length;
  }

  getReviewQueueRowsCount(): number {
    return this.recoverableAudit.rows.filter((row) =>
      row.confidence === 'review' && !row.alreadyRecovered && !this.isIgnoredRecoverableRow(row)
    ).length;
  }

  getIgnoredQueueRowsCount(): number {
    return this.recoverableAudit.rows.filter((row) => this.isIgnoredRecoverableRow(row)).length;
  }

  setRecoverableQueue(queue: RecoverableQueue) {
    this.recoverableQueue = queue;
  }

  setRecoverableDomain(domainId: string) {
    this.recoverableDomainId = domainId;
    this.loadRecoverableAudit();
  }

  exportRecoverableCsv() {
    const rows = this.getFilteredRecoverableRows();
    if (!rows.length) {
      this.errorMessage = 'No recoverable rows to export.';
      return;
    }

    const headers = [
      'order_id',
      'order_number',
      'order_domain_id',
      'order_domain',
      'order_date',
      'phone',
      'normalized_phone',
      'customer_name',
      'candidate_email',
      'candidate_name',
      'candidate_order_id',
      'candidate_order_date',
      'candidate_domain_id',
      'candidate_domain',
      'confidence',
      'candidate_emails_for_phone',
      'candidate_orders_for_phone',
    ];

    const csvRows = rows.map((row) => [
      row.orderId,
      row.orderNumber,
      row.authorizedDomainId,
      this.getDomainLabel(row),
      row.orderDate || '',
      row.phone,
      row.normalizedPhone,
      row.customerName,
      row.candidateEmail,
      row.candidateName,
      row.candidateOrderId,
      row.candidateOrderDate || '',
      row.candidateDomainId,
      this.getCandidateDomainLabel(row),
      row.confidence,
      row.candidateEmailsForPhone,
      row.candidateOrdersForPhone,
    ]);

    const csv = [headers, ...csvRows]
      .map((row) => row.map((value) => this.csvValue(value)).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const domain = this.recoverableDomainId || 'all';
    const url = URL.createObjectURL(blob);

    link.href = url;
    link.download = `recoverable-missing-emails-domain-${domain}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    this.actionMessage = `Exported ${rows.length} recoverable rows.`;
  }

  startRecoverableRecovery(dryRun: boolean) {
    const domainLabel = this.recoverableDomainId ? `D${this.recoverableDomainId}` : 'all domains';
    if (!dryRun && !confirm(`Apply high-confidence email recovery for ${domainLabel}? Review matches will be skipped.`)) {
      return;
    }

    this.recoverableRecoveryLoading = dryRun ? 'dryRun' : 'apply';
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>('/api/imports/inventorypal/recoverable-missing-emails/recover', {
      daysBack: Number(this.recoverableDaysBack) || 365,
      limit: Number(this.recoverableLimit) || 250,
      domainId: this.recoverableDomainId ? Number(this.recoverableDomainId) : undefined,
      dryRun,
    }).subscribe({
      next: (response) => {
        this.recoverableRecoveryResult = response.result || null;
        this.recoverableRecoveryLoading = '';
        this.actionMessage = dryRun ? 'Recovery preview ready.' : 'High-confidence recovery applied.';
        if (!dryRun) {
          this.loadRecoverableAudit();
        }
      },
      error: () => {
        this.errorMessage = 'Recoverable missing email recovery could not be processed.';
        this.recoverableRecoveryLoading = '';
      }
    });
  }

  recoverReviewRow(row: RecoverableMissingEmailRow) {
    const actionKey = `recover-${row.orderId}`;
    if (!confirm(`Recover ${row.candidateEmail} for order #${row.orderNumber || row.orderId}?`)) {
      return;
    }

    this.recoverableRowActionLoading = actionKey;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>('/api/imports/inventorypal/recoverable-missing-emails/recover-review', {
      orderId: row.orderId,
      candidateEmail: row.candidateEmail,
      daysBack: Number(this.recoverableDaysBack) || 365,
      domainId: this.recoverableDomainId ? Number(this.recoverableDomainId) : undefined,
      dryRun: false,
    }).subscribe({
      next: (response) => {
        this.recoverableRecoveryResult = response.result || null;
        this.recoverableRowActionLoading = '';
        this.actionMessage = `Recovered ${row.candidateEmail}.`;
        this.loadRecoverableAudit();
      },
      error: () => {
        this.errorMessage = 'Review email could not be recovered.';
        this.recoverableRowActionLoading = '';
      }
    });
  }

  markRecoverableAsTest(row: RecoverableMissingEmailRow) {
    const actionKey = `test-${row.orderId}`;
    if (!confirm(`Mark ${row.candidateEmail} as test/ignored? It will be blocked from future imports and sending lists.`)) {
      return;
    }

    this.recoverableRowActionLoading = actionKey;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>('/api/emails/quality/test', {
      email: row.candidateEmail,
      reason: `Marked from recoverable missing email review for order ${row.orderId}`,
      sourceIdentifier: `quality_gate_test_supplikit_order_${row.orderId}`,
    }).subscribe({
      next: () => {
        this.recoverableRowActionLoading = '';
        this.actionMessage = `Marked ${row.candidateEmail} as test/ignored.`;
        this.loadRecoverableAudit();
      },
      error: () => {
        this.errorMessage = 'Email could not be marked as test.';
        this.recoverableRowActionLoading = '';
      }
    });
  }

  getRunningJobs(): number {
    return this.jobs.filter((job) => ['pending', 'running'].includes(job.status)).length;
  }

  getCompletedJobs(): number {
    return this.jobs.filter((job) => job.status === 'completed').length;
  }

  getFailedJobs(): number {
    return this.jobs.filter((job) => job.status === 'failed').length;
  }

  getStatusBadgeClass(status: string): string {
    const classes: Record<string, string> = {
      completed: 'ui-badge--success',
      running: 'ui-badge--info',
      pending: 'ui-badge--warning',
      failed: 'ui-badge--danger',
    };

    return classes[status] || 'ui-badge--muted';
  }

  getSyncStateBadgeClass(): string {
    const status = this.overview.syncState?.status || 'idle';
    const classes: Record<string, string> = {
      idle: 'ui-badge--success',
      running: 'ui-badge--info',
      failed: 'ui-badge--danger',
    };

    return classes[status] || 'ui-badge--muted';
  }

  getEffectiveSuppliKitDaysBack(): number {
    return Number(this.overview.syncState?.nextDaysBack || this.daysBack || 1);
  }

  getRecoverableConfidenceClass(confidence: string): string {
    return confidence === 'high' ? 'ui-badge--success' : 'ui-badge--warning';
  }

  getDomainLabel(row: { storeName?: string | null; storeUrl?: string | null; authorizedDomainId?: number }): string {
    return row.storeName || this.hostname(row.storeUrl) || (row.authorizedDomainId ? `Domain ${row.authorizedDomainId}` : '-');
  }

  getCandidateDomainLabel(row: RecoverableMissingEmailRow): string {
    return row.candidateStoreName || this.hostname(row.candidateStoreUrl) || (row.candidateDomainId ? `Domain ${row.candidateDomainId}` : '-');
  }

  private matchesRecoverableQueue(row: RecoverableMissingEmailRow): boolean {
    if (this.recoverableQueue === 'all') {
      return true;
    }

    if (this.recoverableQueue === 'ignored') {
      return this.isIgnoredRecoverableRow(row);
    }

    if (this.recoverableQueue === 'auto') {
      return row.confidence === 'high' || row.alreadyRecovered;
    }

    return row.confidence === 'review' && !row.alreadyRecovered && !this.isIgnoredRecoverableRow(row);
  }

  private isIgnoredRecoverableRow(row: RecoverableMissingEmailRow): boolean {
    return ['invalid', 'disposable', 'unsubscribed'].includes(row.candidateEmailStatus || '');
  }

  private startAction(key: string, endpoint: string, body: Record<string, unknown>) {
    this.actionLoading = key;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>(endpoint, body).subscribe({
      next: (response) => {
        this.actionMessage = response.message || 'Import started.';
        this.actionLoading = '';
        this.refreshImportPage();
      },
      error: () => {
        this.errorMessage = 'Import could not be started.';
        this.actionLoading = '';
      }
    });
  }

  private getRecoverableAuditUrl(): string {
    const params = new URLSearchParams({
      daysBack: String(Number(this.recoverableDaysBack) || 365),
      limit: String(Number(this.recoverableLimit) || 250),
    });

    if (this.recoverableDomainId) {
      params.set('domainId', this.recoverableDomainId);
    }

    return `/api/imports/inventorypal/recoverable-missing-emails?${params.toString()}`;
  }

  private createEmptyRecoverableAudit(): RecoverableMissingEmailAudit {
    return {
      configured: false,
      source: 'none',
      daysBack: this.recoverableDaysBack || 365,
      totalMissingEmailOrders: 0,
      missingWithPhoneOrders: 0,
      recoverableOrders: 0,
      uniqueRecoverablePhones: 0,
      ambiguousPhones: 0,
      alreadyRecoveredOrders: 0,
      rows: [],
    };
  }

  private hostname(value?: string | null): string {
    if (!value) {
      return '';
    }

    try {
      return new URL(value.startsWith('http') ? value : `https://${value}`).hostname.replace(/^www\./, '');
    } catch {
      return value.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  private csvValue(value: unknown): string {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
  }
}
