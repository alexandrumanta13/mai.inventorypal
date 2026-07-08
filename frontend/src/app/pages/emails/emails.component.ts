import { Component, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

interface Email {
  id: number;
  email: string;
  emailDomain?: string;
  customerId?: number;
  verificationStatus: string;
  qualityScore: number;
  hasValidSyntax: boolean;
  hasValidDns: boolean;
  hasValidSmtp: boolean;
  isDisposable: boolean;
  isRoleBased: boolean;
  sendEligibility?: 'pending' | 'safe_to_send' | 'review' | 'do_not_send';
  doNotSendReason?: string;
  lastValidationSource?: string;
  lastValidationAt?: string;
  hasTypo?: boolean;
  typoSuggestion?: string;
  typoResolutionStatus?: 'pending' | 'accepted' | 'ignored';
  typoResolvedEmail?: string;
  typoResolvedAt?: string;
  typoResolutionNote?: string;
  firstName?: string;
  lastName?: string;
  acquisitionSource?: string;
  smtpErrorMessage?: string;
  createdAt: string;
}

interface TypoAuditRow {
  id: number;
  email: string;
  suggestedEmail: string;
  status: string;
  updated: boolean;
}

interface TypoAuditResult {
  scanned: number;
  typosFound: number;
  updated: number;
  clean: number;
  remaining: number;
  completed: boolean;
  dryRun: boolean;
  afterId: number;
  nextAfterId: number | null;
  rows: TypoAuditRow[];
}

interface TypoScanPhaseProgress {
  scanned: number;
  found: number;
  saved: number;
  clean: number;
  remaining: number | null;
  completed: boolean;
}

interface TypoFullScanProgress {
  phase: 'emails' | 'customers' | 'done';
  emails: TypoScanPhaseProgress;
  customers: TypoScanPhaseProgress;
}

interface TypoFullScanJob {
  id: string;
  name: string;
  state: string;
  progress?: TypoFullScanProgress | number;
  result?: TypoFullScanProgress;
  failedReason?: string;
  createdAt?: string | null;
  processedAt?: string | null;
  finishedAt?: string | null;
}

interface TypoFullScanStatus {
  queue: {
    active: number;
    waiting: number;
    completed: number;
    failed: number;
  };
  job: TypoFullScanJob | null;
}

type TypoResolutionStatus = 'pending' | 'accepted' | 'ignored';
type TypoResolutionAction = 'accept' | 'ignore' | 'reset';
type NeverBounceSegment =
  | 'typo_resolved'
  | 'domain'
  | 'recovery_all'
  | 'recovery_domain_typo'
  | 'recovery_name_typo'
  | 'recovery_manual_edit';
type CampaignEligibility = 'safe_to_send' | 'review' | 'pending';

interface EmailDomainOption {
  domain: string;
  count: number;
}

interface NeverBounceExportRow {
  email: string;
  originalEmail: string;
  emailId: number;
  customerId?: number | null;
  originalDomain: string;
  exportDomain: string;
  segment: NeverBounceSegment | 'typo_suggestions';
  verificationStatus: string;
  qualityScore: number;
  acquisitionSource: string;
  firstName: string;
  lastName: string;
  recoveryReason?: string;
  recoveryConfidence?: string;
  recoverySource?: string;
  sendEligibility?: string;
  doNotSendReason?: string;
}

interface NeverBouncePreview {
  segment: NeverBounceSegment;
  domain?: string;
  batch: number;
  limit: number;
  offset: number;
  total: number;
  totalBatches: number;
  rows: NeverBounceExportRow[];
}

interface CampaignExportRow {
  email: string;
  emailId: number;
  customerId?: number | null;
  firstName: string;
  lastName: string;
  emailDomain: string;
  sendEligibility: string;
  doNotSendReason: string;
  verificationStatus: string;
  qualityScore: number;
  acquisitionSource: string;
}

interface CampaignPreview {
  eligibility: CampaignEligibility;
  domain?: string;
  batch: number;
  limit: number;
  offset: number;
  total: number;
  totalBatches: number;
  rows: CampaignExportRow[];
}

@Component({
  selector: 'app-emails',
  standalone: false,
  templateUrl: './emails.component.html',
  styleUrls: ['./emails.component.scss']
})
export class EmailsComponent implements OnInit, OnDestroy {
  emails: Email[] = [];
  loading = true;
  errorMessage = '';
  actionMessage = '';
  selectedEmailIds = new Set<number>();
  activeTab: 'list' | 'analytics' | 'risk' | 'typos' | 'validation' = 'list';

  // Pagination
  currentPage = 1;
  pageSize = 100;
  totalEmails = 0;
  totalPages = 0;

  // Filters
  searchTerm = '';
  statusFilter = '';
  domainFilter = '';
  sendEligibilityFilter = '';
  doNotSendReasonFilter = '';
  readonly sendEligibilityOptions = [
    { value: 'pending', label: 'Pending' },
    { value: 'safe_to_send', label: 'Safe to send' },
    { value: 'review', label: 'Review' },
    { value: 'do_not_send', label: 'Do not send' },
  ];
  readonly doNotSendReasonOptions = [
    'unsubscribed',
    'invalid',
    'bounce',
    'disposable',
    'typo_ignored',
    'typo_pending',
    'typo_accepted_external_validation_required',
    'role_based',
    'unknown',
    'risky',
    'abuse_detected',
    'low_quality_score',
  ];

  // Email domains for filter dropdown
  emailDomains: string[] = [];
  loadingDomains = false;

  // Analytics
  analytics: any = null;
  loadingAnalytics = false;
  showAnalytics = true;

  // Top Domains
  topDomains: any[] = [];
  loadingTopDomains = false;

  // Quality Distribution
  qualityDistribution: any[] = [];
  loadingQualityDistribution = false;

  // Email Providers
  emailProviders: any[] = [];
  loadingEmailProviders = false;

  // Risk Assessment
  riskAssessment: any = null;
  loadingRiskAssessment = false;

  // Deliverability
  deliverability: any = null;
  loadingDeliverability = false;

  // Typo recovery
  typoEmails: Email[] = [];
  typoTotal = 0;
  typoLoading = false;
  typoAuditLoading = false;
  typoAuditResult: TypoAuditResult | null = null;
  typoFullScanStatus: TypoFullScanStatus | null = null;
  typoFullScanLoading = false;
  typoResolutionFilter: TypoResolutionStatus = 'pending';
  typoSearchTerm = '';
  typoCurrentPage = 1;
  typoPageSize = 100;
  typoTotalPages = 0;
  selectedTypoIds = new Set<number>();
  typoResolving = false;

  // NeverBounce CSV export
  neverBounceSegment: NeverBounceSegment = 'recovery_all';
  neverBounceDomain = '';
  neverBounceBatch = 1;
  neverBounceLimit = 1000;
  neverBouncePreview: NeverBouncePreview | null = null;
  neverBounceLoading = false;
  neverBounceDownloading = false;
  emailDomainOptions: EmailDomainOption[] = [];

  // Campaign CSV export
  campaignEligibility: CampaignEligibility = 'safe_to_send';
  campaignDomain = '';
  campaignBatch = 1;
  campaignLimit = 1000;
  campaignPreview: CampaignPreview | null = null;
  campaignLoading = false;
  campaignDownloading = false;

  // Search debounce
  private searchSubject = new Subject<string>();
  private typoSearchSubject = new Subject<string>();
  private typoFullScanPollTimer: any = null;

  constructor(private http: HttpClient) {
    // Setup live search with 300ms debounce
    this.searchSubject.pipe(
      debounceTime(300),
      distinctUntilChanged()
    ).subscribe(searchTerm => {
      this.searchTerm = searchTerm;
      this.currentPage = 1;
      this.loadEmails();
    });

    this.typoSearchSubject.pipe(
      debounceTime(300),
      distinctUntilChanged()
    ).subscribe(searchTerm => {
      this.typoSearchTerm = searchTerm;
      this.typoCurrentPage = 1;
      this.loadTypoEmails();
    });
  }

  ngOnInit() {
    this.loadEmails();
    this.loadEmailDomains();
    this.loadAnalytics();
    this.loadTopDomains();
    this.loadQualityDistribution();
    this.loadEmailProviders();
    this.loadRiskAssessment();
    this.loadDeliverability();
    this.loadTypoEmails();
    this.loadTypoFullScanStatus();
  }

  ngOnDestroy() {
    this.searchSubject.complete();
    this.typoSearchSubject.complete();
    if (this.typoFullScanPollTimer) {
      clearTimeout(this.typoFullScanPollTimer);
    }
  }

  loadEmails() {
    this.loading = true;
    this.errorMessage = '';

    const params: any = {
      page: this.currentPage,
      limit: this.pageSize
    };

    if (this.statusFilter) {
      params.status = this.statusFilter;
    }

    if (this.searchTerm) {
      params.search = this.searchTerm;
    }

    if (this.domainFilter) {
      params.emailDomain = this.domainFilter;
    }

    if (this.sendEligibilityFilter) {
      params.sendEligibility = this.sendEligibilityFilter;
    }

    if (this.doNotSendReasonFilter) {
      params.doNotSendReason = this.doNotSendReasonFilter;
    }

    this.http.get<any>('/api/emails', { params }).subscribe({
      next: (response) => {
        this.emails = response.data || [];
        this.totalEmails = response.pagination?.total || 0;
        this.totalPages = response.pagination?.totalPages || 0;
        this.selectedEmailIds.clear();
        this.loading = false;
      },
      error: (error) => {
        console.error('Failed to load emails:', error);
        this.errorMessage = 'Emails could not be loaded.';
        this.loading = false;
      }
    });
  }

  onPageChange(page: number) {
    this.currentPage = page;
    this.loadEmails();
  }

  onSearchInput(searchTerm: string) {
    this.searchSubject.next(searchTerm);
  }

  onFilterChange() {
    this.currentPage = 1;
    this.loadEmails();
  }

  clearListFilters() {
    this.searchTerm = '';
    this.statusFilter = '';
    this.domainFilter = '';
    this.sendEligibilityFilter = '';
    this.doNotSendReasonFilter = '';
    this.currentPage = 1;
    this.loadEmails();
  }

  getStatusBadgeClass(status: string): string {
    const classes: any = {
      'valid': 'ui-badge--valid',
      'invalid': 'ui-badge--invalid',
      'risky': 'ui-badge--risky',
      'disposable': 'ui-badge--disposable',
      'unsubscribed': 'ui-badge--unsubscribed',
      'pending': 'ui-badge--pending'
    };
    return classes[status] || 'ui-badge--pending';
  }

  getEligibilityBadgeClass(eligibility?: string): string {
    const classes: Record<string, string> = {
      safe_to_send: 'ui-badge--success',
      pending: 'ui-badge--info',
      review: 'ui-badge--warning',
      do_not_send: 'ui-badge--danger',
    };
    return classes[eligibility || 'pending'] || 'ui-badge--info';
  }

  getEligibilityLabel(eligibility?: string): string {
    const labels: Record<string, string> = {
      safe_to_send: 'Safe',
      pending: 'Pending',
      review: 'Review',
      do_not_send: 'Blocked',
    };
    return labels[eligibility || 'pending'] || eligibility || 'Pending';
  }

  getReasonLabel(reason?: string): string {
    return reason ? reason.replace(/_/g, ' ') : '';
  }

  setActiveTab(tab: 'list' | 'analytics' | 'risk' | 'typos' | 'validation') {
    this.activeTab = tab;
    if (tab === 'typos') {
      this.loadTypoEmails();
      this.loadTypoFullScanStatus();
    }
  }

  trackEmail(_: number, email: Email): number {
    return email.id;
  }

  isSelected(emailId: number): boolean {
    return this.selectedEmailIds.has(emailId);
  }

  toggleEmailSelection(emailId: number, checked: boolean) {
    if (checked) {
      this.selectedEmailIds.add(emailId);
    } else {
      this.selectedEmailIds.delete(emailId);
    }
  }

  toggleAllVisible(checked: boolean) {
    this.selectedEmailIds.clear();
    if (checked) {
      this.emails.forEach((email) => this.selectedEmailIds.add(email.id));
    }
  }

  allVisibleSelected(): boolean {
    return this.emails.length > 0 && this.emails.every((email) => this.selectedEmailIds.has(email.id));
  }

  getSelectedCount(): number {
    return this.selectedEmailIds.size;
  }

  verifySelected() {
    const emailIds = Array.from(this.selectedEmailIds);
    if (emailIds.length === 0) return;

    this.http.post('/api/verification/start-by-ids', { emailIds, skipSmtp: false }).subscribe({
      next: () => {
        this.actionMessage = `Queued ${emailIds.length} emails for verification.`;
        this.selectedEmailIds.clear();
      },
      error: () => {
        this.errorMessage = 'Selected emails could not be queued for verification.';
      }
    });
  }

  loadTypoEmails() {
    this.typoLoading = true;

    const params: any = {
        page: this.typoCurrentPage,
        limit: this.typoPageSize,
        hasTypo: true,
        typoResolutionStatus: this.typoResolutionFilter,
    };

    if (this.typoSearchTerm) {
      params.search = this.typoSearchTerm;
    }

    this.http.get<any>('/api/emails', { params }).subscribe({
      next: (response) => {
        this.typoEmails = response.data || [];
        this.typoTotal = response.pagination?.total || 0;
        this.typoTotalPages = response.pagination?.totalPages || 0;
        this.selectedTypoIds.clear();
        this.typoLoading = false;
      },
      error: (error) => {
        console.error('Failed to load typo emails:', error);
        this.errorMessage = 'Typo candidates could not be loaded.';
        this.typoLoading = false;
      }
    });
  }

  onTypoResolutionFilterChange() {
    this.typoCurrentPage = 1;
    this.loadTypoEmails();
  }

  onTypoSearchInput(searchTerm: string) {
    this.typoSearchSubject.next(searchTerm);
  }

  onTypoPageSizeChange() {
    this.typoCurrentPage = 1;
    this.loadTypoEmails();
  }

  onTypoPageChange(page: number) {
    this.typoCurrentPage = Math.min(Math.max(page, 1), this.typoTotalPages || 1);
    this.loadTypoEmails();
  }

  getTypoPages(): number[] {
    const pages: number[] = [];
    const maxVisible = 5;
    const totalPages = this.typoTotalPages || 0;
    if (!totalPages) return pages;

    let start = Math.max(1, this.typoCurrentPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);

    if (end - start < maxVisible - 1) {
      start = Math.max(1, end - maxVisible + 1);
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    return pages;
  }

  isTypoSelected(emailId: number): boolean {
    return this.selectedTypoIds.has(emailId);
  }

  toggleTypoSelection(emailId: number, checked: boolean) {
    if (checked) {
      this.selectedTypoIds.add(emailId);
    } else {
      this.selectedTypoIds.delete(emailId);
    }
  }

  toggleAllVisibleTypos(checked: boolean) {
    this.selectedTypoIds.clear();
    if (checked) {
      this.typoEmails.forEach((email) => this.selectedTypoIds.add(email.id));
    }
  }

  allVisibleTyposSelected(): boolean {
    return this.typoEmails.length > 0 && this.typoEmails.every((email) => this.selectedTypoIds.has(email.id));
  }

  getSelectedTypoCount(): number {
    return this.selectedTypoIds.size;
  }

  resolveTypo(email: Email, action: TypoResolutionAction) {
    if (action === 'ignore' && !confirm(`Ignore ${email.email} and exclude it from sending flows?`)) {
      return;
    }

    this.typoResolving = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.patch<any>(`/api/emails/${email.id}/typo-resolution`, {
      action,
      resolvedEmail: action === 'accept' ? email.typoSuggestion : undefined,
    }).subscribe({
      next: () => {
        this.actionMessage = action === 'accept'
          ? `Accepted ${email.typoSuggestion || email.email} for validation.`
          : `Ignored ${email.email}.`;
        this.typoResolving = false;
        this.loadTypoEmails();
        this.loadDeliverability();
        this.loadRiskAssessment();
      },
      error: (error) => {
        console.error('Failed to resolve typo candidate:', error);
        this.errorMessage = 'Typo candidate could not be resolved.';
        this.typoResolving = false;
      }
    });
  }

  resolveSelectedTypos(action: TypoResolutionAction) {
    const emailIds = Array.from(this.selectedTypoIds);
    if (!emailIds.length) {
      return;
    }

    if (action === 'ignore' && !confirm(`Ignore ${emailIds.length} selected typo candidates?`)) {
      return;
    }

    this.typoResolving = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>('/api/emails/typos/resolve-bulk', {
      emailIds,
      action,
    }).subscribe({
      next: (response) => {
        const result = response.result || {};
        this.actionMessage = `${result.resolved || 0} typo candidates updated.`;
        this.typoResolving = false;
        this.loadTypoEmails();
        this.loadDeliverability();
        this.loadRiskAssessment();
      },
      error: (error) => {
        console.error('Failed to resolve typo candidates:', error);
        this.errorMessage = 'Selected typo candidates could not be resolved.';
        this.typoResolving = false;
      }
    });
  }

  startFullTypoScan() {
    if (!confirm('Start a full typo scan for emails and customers? Existing scanned rows will be skipped.')) {
      return;
    }

    this.typoAuditLoading = true;
    this.typoFullScanLoading = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>('/api/verification/typo-audit/full-scan/start', {
      chunkSize: 50000,
    }).subscribe({
      next: (response) => {
        this.typoFullScanStatus = {
          queue: response.queue || this.typoFullScanStatus?.queue || { active: 0, waiting: 0, completed: 0, failed: 0 },
          job: response.job || null,
        };
        this.actionMessage = response.alreadyRunning
          ? 'A full typo scan is already running.'
          : 'Full typo scan started. You can keep using the app while it runs.';
        this.typoAuditLoading = false;
        this.typoFullScanLoading = false;
        this.scheduleTypoFullScanPoll();
      },
      error: (error) => {
        console.error('Failed to start typo scan:', error);
        this.errorMessage = 'Full typo scan could not be started.';
        this.typoAuditLoading = false;
        this.typoFullScanLoading = false;
      }
    });
  }

  resetTypoScanProgress() {
    this.typoAuditResult = null;
    if (!confirm('Reset typo scan progress for emails and customers? The next full scan will review everything again.')) {
      return;
    }

    this.typoAuditLoading = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.post<any>('/api/verification/typo-audit/reset-progress', {
      scope: 'all',
    }).subscribe({
      next: (response) => {
        const emailsReset = response.result?.emails?.reset || 0;
        const customersReset = response.result?.customers?.reset || 0;
        this.actionMessage = `Reset scan progress for ${emailsReset} emails and ${customersReset} customers.`;
        this.typoAuditLoading = false;
        this.loadTypoFullScanStatus();
      },
      error: (error) => {
        console.error('Failed to reset typo scan progress:', error);
        this.errorMessage = 'Typo scan progress could not be reset.';
        this.typoAuditLoading = false;
      }
    });
  }

  loadTypoFullScanStatus() {
    const wasRunning = this.isTypoFullScanRunning();

    this.http.get<any>('/api/verification/typo-audit/full-scan/status').subscribe({
      next: (response) => {
        this.typoFullScanStatus = {
          queue: response.queue || { active: 0, waiting: 0, completed: 0, failed: 0 },
          job: response.job || null,
        };

        if (this.isTypoFullScanRunning()) {
          this.scheduleTypoFullScanPoll();
        } else {
          this.typoFullScanLoading = false;
          if (wasRunning) {
            this.loadTypoEmails();
            this.loadDeliverability();
            this.loadRiskAssessment();
          }
        }
      },
      error: (error) => {
        console.error('Failed to load typo scan status:', error);
        this.typoFullScanLoading = false;
      }
    });
  }

  refreshTypoFullScanStatus() {
    this.typoFullScanLoading = true;
    this.loadTypoFullScanStatus();
  }

  getTypoFullScanProgress(): TypoFullScanProgress | null {
    const job = this.typoFullScanStatus?.job;
    if (!job) return null;
    if (job.result) return job.result;
    return typeof job.progress === 'object' ? job.progress : null;
  }

  getTypoFullScanState(): string {
    return this.typoFullScanStatus?.job?.state || 'not started';
  }

  getTypoFullScanPhaseLabel(): string {
    const progress = this.getTypoFullScanProgress();
    const phase = progress?.phase;
    if (phase === 'emails') return 'Scanning emails';
    if (phase === 'customers') return 'Scanning customers';
    if (phase === 'done') return 'Complete';
    return 'Idle';
  }

  getTypoFullScanTotal(metric: keyof TypoScanPhaseProgress): number {
    const progress = this.getTypoFullScanProgress();
    const emailValue = Number(progress?.emails?.[metric] || 0);
    const customerValue = Number(progress?.customers?.[metric] || 0);
    return emailValue + customerValue;
  }

  isTypoFullScanRunning(): boolean {
    const state = this.getTypoFullScanState();
    const queue = this.typoFullScanStatus?.queue;
    return state === 'active' || state === 'waiting' || (queue?.active || 0) > 0 || (queue?.waiting || 0) > 0;
  }

  private scheduleTypoFullScanPoll() {
    if (this.typoFullScanPollTimer) {
      clearTimeout(this.typoFullScanPollTimer);
    }

    this.typoFullScanPollTimer = setTimeout(() => {
      this.loadTypoFullScanStatus();
    }, 5000);
  }

  onNeverBounceSegmentChange() {
    this.neverBounceBatch = 1;
    if (this.neverBounceSegment !== 'domain') {
      this.neverBounceDomain = '';
    }
    this.neverBouncePreview = null;
  }

  onCampaignExportChange() {
    this.campaignBatch = 1;
    this.campaignPreview = null;
  }

  loadCampaignPreview() {
    this.campaignLoading = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.get<CampaignPreview>('/api/emails/campaign/preview', {
      params: this.getCampaignParams()
    }).subscribe({
      next: (response) => {
        this.campaignPreview = response;
        const label = this.getEligibilityLabel(response.eligibility);
        this.actionMessage = `${label} campaign preview loaded: ${response.rows.length} rows in batch ${response.batch} of ${response.totalBatches || 1}.`;
        this.campaignLoading = false;
      },
      error: (error) => {
        console.error('Failed to load campaign preview:', error);
        this.errorMessage = 'Campaign preview could not be loaded.';
        this.campaignLoading = false;
      }
    });
  }

  downloadCampaignCsv() {
    this.campaignDownloading = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.get('/api/emails/campaign/export.csv', {
      params: this.getCampaignParams(),
      responseType: 'blob',
      observe: 'response',
    }).subscribe({
      next: (response) => {
        const blob = response.body || new Blob([], { type: 'text/csv' });
        const disposition = response.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="([^"]+)"/);
        const filename = filenameMatch?.[1] || this.getCampaignFilename();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        window.URL.revokeObjectURL(url);
        this.actionMessage = `Downloaded ${filename}.`;
        this.campaignDownloading = false;
      },
      error: (error) => {
        console.error('Failed to download campaign CSV:', error);
        this.errorMessage = 'Campaign CSV could not be downloaded.';
        this.campaignDownloading = false;
      }
    });
  }

  private getCampaignParams(): Record<string, string> {
    const params: Record<string, string> = {
      eligibility: this.campaignEligibility,
      batch: String(Math.max(Number(this.campaignBatch) || 1, 1)),
      limit: String(Math.min(Math.max(Number(this.campaignLimit) || 1000, 1), 5000)),
    };

    if (this.campaignDomain) {
      params['domain'] = this.campaignDomain;
    }

    return params;
  }

  private getCampaignFilename(): string {
    const label = this.campaignDomain
      ? `${this.campaignEligibility}-${this.campaignDomain.replace(/[^a-z0-9]+/g, '-')}`
      : this.campaignEligibility;

    return `campaign-${label}-batch-${String(this.campaignBatch).padStart(3, '0')}.csv`;
  }

  loadNeverBouncePreview() {
    if (this.neverBounceSegment === 'domain' && !this.neverBounceDomain) {
      this.errorMessage = 'Choose a domain before previewing a NeverBounce domain export.';
      return;
    }

    this.neverBounceLoading = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.get<NeverBouncePreview>('/api/emails/neverbounce/preview', {
      params: this.getNeverBounceParams()
    }).subscribe({
      next: (response) => {
        this.neverBouncePreview = response;
        this.actionMessage = `Export preview loaded: ${response.rows.length} rows in batch ${response.batch} of ${response.totalBatches || 1}. No data was changed.`;
        this.neverBounceLoading = false;
      },
      error: (error) => {
        console.error('Failed to load NeverBounce preview:', error);
        this.errorMessage = 'NeverBounce preview could not be loaded.';
        this.neverBounceLoading = false;
      }
    });
  }

  downloadNeverBounceCsv() {
    if (this.neverBounceSegment === 'domain' && !this.neverBounceDomain) {
      this.errorMessage = 'Choose a domain before exporting a NeverBounce CSV.';
      return;
    }

    this.neverBounceDownloading = true;
    this.errorMessage = '';
    this.actionMessage = '';

    this.http.get('/api/emails/neverbounce/export.csv', {
      params: this.getNeverBounceParams(),
      responseType: 'blob',
      observe: 'response',
    }).subscribe({
      next: (response) => {
        const blob = response.body || new Blob([], { type: 'text/csv' });
        const disposition = response.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="([^"]+)"/);
        const filename = filenameMatch?.[1] || this.getNeverBounceFilename();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        window.URL.revokeObjectURL(url);
        this.actionMessage = `Downloaded ${filename}. Import the NeverBounce results separately after verification.`;
        this.neverBounceDownloading = false;
      },
      error: (error) => {
        console.error('Failed to download NeverBounce CSV:', error);
        this.errorMessage = 'NeverBounce CSV could not be downloaded.';
        this.neverBounceDownloading = false;
      }
    });
  }

  private getNeverBounceParams(): Record<string, string> {
    const params: Record<string, string> = {
      segment: this.neverBounceSegment,
      batch: String(Math.max(Number(this.neverBounceBatch) || 1, 1)),
      limit: String(Math.min(Math.max(Number(this.neverBounceLimit) || 1000, 1), 1000)),
    };

    if (this.neverBounceSegment === 'domain') {
      params['domain'] = this.neverBounceDomain;
    }

    return params;
  }

  private getNeverBounceFilename(): string {
    const label = this.neverBounceSegment === 'domain'
      ? `domain-${this.neverBounceDomain.replace(/[^a-z0-9]+/g, '-')}`
      : this.neverBounceSegment.replace(/_/g, '-');

    return `neverbounce-${label}-batch-${String(this.neverBounceBatch).padStart(3, '0')}.csv`;
  }

  getPages(): number[] {
    const pages: number[] = [];
    const maxVisible = 5;

    let start = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
    let end = Math.min(this.totalPages, start + maxVisible - 1);

    if (end - start < maxVisible - 1) {
      start = Math.max(1, end - maxVisible + 1);
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    return pages;
  }

  loadEmailDomains() {
    this.loadingDomains = true;
    this.http.get<any>('/api/emails/domains', { params: { limit: 500 } }).subscribe({
      next: (response) => {
        // API returns array of {domain, count} objects
        this.emailDomainOptions = (response || []).map((item: any) => ({
          domain: item.domain,
          count: Number(item.count || 0),
        }));
        this.emailDomains = this.emailDomainOptions.map((item) => item.domain);
        this.loadingDomains = false;
      },
      error: (error) => {
        console.error('Failed to load email domains:', error);
        this.loadingDomains = false;
      }
    });
  }

  getCommercialDomainOptions(): EmailDomainOption[] {
    const recommended = new Set([
      'gmail.com',
      'yahoo.com',
      'yahoo.ro',
      'outlook.com',
      'hotmail.com',
      'live.com',
      'icloud.com',
      'me.com',
      'aol.com',
      'proton.me',
      'protonmail.com',
      'zoho.com',
    ]);

    return this.emailDomainOptions
      .filter((item) => recommended.has(item.domain))
      .slice(0, 12);
  }

  chooseNeverBounceDomain(domain: string) {
    this.neverBounceSegment = 'domain';
    this.neverBounceDomain = domain;
    this.neverBounceBatch = 1;
    this.neverBouncePreview = null;
  }

  markAsRisky(emailId: number) {
    if (!confirm('Mark this email as risky?')) {
      return;
    }

    this.http.patch(`/api/emails/${emailId}/status`, { status: 'risky' }).subscribe({
      next: () => {
        this.actionMessage = 'Email marked as risky.';
        this.loadEmails();
      },
      error: (error) => {
        console.error('Failed to mark email as risky:', error);
        this.errorMessage = 'Failed to update email status.';
      }
    });
  }

  unsubscribe(emailId: number) {
    if (!confirm('Unsubscribe this email?')) {
      return;
    }

    this.http.patch(`/api/emails/${emailId}/status`, { status: 'unsubscribed' }).subscribe({
      next: () => {
        this.actionMessage = 'Email unsubscribed.';
        this.loadEmails();
      },
      error: (error) => {
        console.error('Failed to unsubscribe email:', error);
        this.errorMessage = 'Failed to update email status.';
      }
    });
  }

  loadAnalytics() {
    this.loadingAnalytics = true;
    this.http.get<any>('/api/emails/analytics/overview').subscribe({
      next: (response) => {
        this.analytics = response;
        this.loadingAnalytics = false;
      },
      error: (error) => {
        console.error('Failed to load analytics:', error);
        this.loadingAnalytics = false;
      }
    });
  }

  loadTopDomains() {
    this.loadingTopDomains = true;
    this.http.get<any>('/api/emails/analytics/customer-linkage').subscribe({
      next: (response) => {
        this.topDomains = response || [];
        this.loadingTopDomains = false;
      },
      error: (error) => {
        console.error('Failed to load top domains:', error);
        this.loadingTopDomains = false;
      }
    });
  }

  loadQualityDistribution() {
    this.loadingQualityDistribution = true;
    this.http.get<any>('/api/emails/analytics/quality-distribution').subscribe({
      next: (response) => {
        this.qualityDistribution = response || [];
        this.loadingQualityDistribution = false;
      },
      error: (error) => {
        console.error('Failed to load quality distribution:', error);
        this.loadingQualityDistribution = false;
      }
    });
  }

  loadEmailProviders() {
    this.loadingEmailProviders = true;
    this.http.get<any>('/api/emails/analytics/email-providers').subscribe({
      next: (response) => {
        this.emailProviders = response || [];
        this.loadingEmailProviders = false;
      },
      error: (error) => {
        console.error('Failed to load email providers:', error);
        this.loadingEmailProviders = false;
      }
    });
  }

  loadRiskAssessment() {
    this.loadingRiskAssessment = true;
    this.http.get<any>('/api/emails/analytics/risk-assessment').subscribe({
      next: (response) => {
        this.riskAssessment = response;
        this.loadingRiskAssessment = false;
      },
      error: (error) => {
        console.error('Failed to load risk assessment:', error);
        this.loadingRiskAssessment = false;
      }
    });
  }

  loadDeliverability() {
    this.loadingDeliverability = true;
    this.http.get<any>('/api/emails/analytics/deliverability').subscribe({
      next: (response) => {
        this.deliverability = response;
        this.loadingDeliverability = false;
      },
      error: (error) => {
        console.error('Failed to load deliverability:', error);
        this.loadingDeliverability = false;
      }
    });
  }

  toggleAnalytics() {
    this.showAnalytics = !this.showAnalytics;
  }

  getStatusPercentage(status: string): number {
    if (!this.analytics || !this.analytics.total) return 0;
    const count = this.analytics.byStatus[status] || 0;
    return (count / this.analytics.total) * 100;
  }
}
