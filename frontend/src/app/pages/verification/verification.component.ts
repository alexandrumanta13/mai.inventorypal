import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

interface IntakeOverview {
  totals: {
    emails: number;
    pendingValidation: number;
    safeToSend: number;
    riskyOrReview: number;
    doNotSend: number;
    typoReview: number;
    bounceInvalid: number;
  };
  byStatus: Record<string, number>;
  topCommercialDomains: Array<{
    domain: string;
    count: number;
    pendingValidation: number;
    validated: number;
  }>;
}

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  total: number;
}

interface TypoScanJob {
  id: string;
  state: string;
  progress: any;
  data: any;
  result: any;
}

interface BounceRecoverySummary {
  byStatus: Record<string, number>;
  pendingByReason: Record<string, number>;
}

interface BounceRecoveryCandidate {
  id: number;
  bouncedEmail: string;
  suggestedEmail: string;
  reason: 'domain_typo' | 'name_localpart_typo';
  confidence: 'high' | 'medium';
  status: 'pending' | 'approved' | 'ignored';
  source: string;
  bouncedAt?: string;
  createdAt: string;
  emailId?: number;
  customerId?: number;
  customerName?: string;
  currentEmailStatus?: string;
  existingSuggestedStatus?: string;
  suggestionEdited?: boolean;
}

type RecoveryExportSegment =
  | 'recovery_all'
  | 'recovery_domain_typo'
  | 'recovery_name_typo'
  | 'recovery_manual_edit';

interface RecoveryExportPreviewRow {
  email: string;
  originalEmail: string;
  emailId: number;
  customerId?: number | null;
  exportDomain: string;
  segment: RecoveryExportSegment;
  verificationStatus: string;
  qualityScore: number;
  acquisitionSource: string;
  recoveryReason?: string;
  recoveryConfidence?: string;
  recoverySource?: string;
  sendEligibility?: string;
  doNotSendReason?: string;
}

interface RecoveryExportPreview {
  segment: RecoveryExportSegment;
  batch: number;
  limit: number;
  offset: number;
  total: number;
  totalBatches: number;
  rows: RecoveryExportPreviewRow[];
}

interface ExternalResultImportSummary {
  dryRun: boolean;
  provider: 'zerobounce' | 'neverbounce';
  received: number;
  processed: number;
  matched: number;
  missing: number;
  updated: number;
  byMappedStatus: Record<string, number>;
  rows: Array<{
    email: string;
    emailId: number | null;
    providerStatus: string;
    providerSubStatus: string | null;
    mappedStatus: string;
    action: string;
    sendEligibility: string;
    reasonCode: string | null;
  }>;
}

type ZeroBounceSegment = 'smtp_failed_internal' | 'typo_resolved' | 'external_review';

interface ZeroBounceCredits {
  configured: boolean;
  credits: number | null;
  validKey: boolean | null;
}

interface ZeroBouncePreview {
  configured: boolean;
  validKey: boolean | null;
  segment: ZeroBounceSegment;
  limit: number;
  total: number;
  estimatedCredits: number;
  credits: number | null;
  rows: Array<{
    id: number;
    email: string;
    verificationStatus: string;
    sendEligibility: string;
    doNotSendReason: string | null;
    lastValidationSource: string | null;
    lastValidationAt: string | null;
    source: string | null;
  }>;
}

interface ZeroBounceRunResult {
  dryRun: boolean;
  preview: ZeroBouncePreview;
  submitted: number;
  creditsBefore: number | null;
  importResult: ExternalResultImportSummary | null;
}

interface SuppressionOverview {
  totals: {
    doNotSend: number;
    elasticSuppressionRows: number;
    elasticDoNotSendRows: number;
    bounceAfterUnsubscribe: number;
    gmailBounces: number;
    gmailUnsubscribes: number;
    gmailAbuse: number;
    elasticEvents: number;
  };
  doNotSendByReason: Record<string, number>;
  doNotSendBySource: Record<string, number>;
  elasticEventsByStatus: Record<string, number>;
  elasticEventsByReason: Record<string, number>;
  gmailByCategory: Record<string, number>;
}

interface MapRow {
  key: string;
  count: number;
}

@Component({
  selector: 'app-verification',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './verification.component.html',
  styleUrls: ['./verification.component.scss']
})
export class VerificationComponent implements OnInit {
  loading = false;
  actionLoading = '';
  errorMessage = '';
  actionMessage = '';
  lastUpdated: Date | null = null;

  overview: IntakeOverview = this.createEmptyOverview();
  queue: QueueStats = {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    total: 0,
  };
  typoScanJob: TypoScanJob | null = null;
  bounceSummary: BounceRecoverySummary = {
    byStatus: {},
    pendingByReason: {},
  };
  bounceCandidates: BounceRecoveryCandidate[] = [];
  bounceTotal = 0;
  bounceLimit = 25;
  bounceOffset = 0;
  bounceStatus: 'pending' | 'approved' | 'ignored' = 'pending';
  bounceSearch = '';
  editingBounceId: number | null = null;
  bounceEditEmail = '';
  recoveryExportSegment: RecoveryExportSegment = 'recovery_all';
  recoveryExportBatch = 1;
  recoveryExportLimit = 1000;
  recoveryExportPreview: RecoveryExportPreview | null = null;
  recoveryExportLoading = false;
  recoveryExportDownloading = false;
  externalImportProvider: 'zerobounce' | 'neverbounce' = 'zerobounce';
  externalImportCsv = '';
  externalImportPreview: ExternalResultImportSummary | null = null;
  externalImportLoading = false;
  zeroBounceCredits: ZeroBounceCredits = {
    configured: false,
    credits: null,
    validKey: null,
  };
  zeroBounceSegment: ZeroBounceSegment = 'smtp_failed_internal';
  zeroBounceLimit = 35;
  zeroBouncePreview: ZeroBouncePreview | null = null;
  zeroBounceRunResult: ZeroBounceRunResult | null = null;
  zeroBounceLoading = '';
  validationLimit = 1000;
  skipSmtp = false;
  suppressionOverview: SuppressionOverview = this.createEmptySuppressionOverview();
  doNotSendReasonRows: MapRow[] = [];
  doNotSendSourceRows: MapRow[] = [];
  elasticEventStatusRows: MapRow[] = [];
  elasticEventReasonRows: MapRow[] = [];
  gmailSignalRows: MapRow[] = [];

  constructor(private readonly http: HttpClient) {}

  ngOnInit() {
    this.loadValidation();
  }

  loadValidation() {
    this.loading = true;
    this.errorMessage = '';

    forkJoin({
      overview: this.http.get<any>('/api/verification/intake-overview').pipe(
        catchError(() => of({ overview: this.createEmptyOverview() })),
      ),
      queue: this.http.get<any>('/api/verification/queue-stats').pipe(
        catchError(() => of({ queue: this.queue })),
      ),
      typo: this.http.get<any>('/api/verification/typo-audit/full-scan/status').pipe(
        catchError(() => of({ job: null })),
      ),
      bounceSummary: this.http.get<any>('/api/verification/bounce-recovery/summary').pipe(
        catchError(() => of({ summary: this.bounceSummary })),
      ),
      bounceList: this.http.get<any>(this.getBounceRecoveryUrl()).pipe(
        catchError(() => of({ result: { total: 0, items: [] } })),
      ),
      suppression: this.http.get<any>('/api/verification/suppression-overview').pipe(
        catchError(() => of({ overview: this.createEmptySuppressionOverview() })),
      ),
      zeroBounceCredits: this.http.get<any>('/api/verification/zerobounce/credits').pipe(
        catchError(() => of({ result: this.zeroBounceCredits })),
      ),
    }).subscribe({
      next: (response) => {
        this.overview = response.overview.overview || this.createEmptyOverview();
        this.queue = response.queue.queue || this.queue;
        this.typoScanJob = response.typo.job || null;
        this.bounceSummary = response.bounceSummary.summary || this.bounceSummary;
        this.bounceTotal = Number(response.bounceList.result?.total || 0);
        this.bounceCandidates = response.bounceList.result?.items || [];
        this.setSuppressionOverview(response.suppression.overview || this.createEmptySuppressionOverview());
        this.zeroBounceCredits = response.zeroBounceCredits.result || this.zeroBounceCredits;
        this.lastUpdated = new Date();
        this.loading = false;
      },
      error: () => {
        this.errorMessage = 'Validation data could not be loaded.';
        this.loading = false;
      }
    });
  }

  startPendingValidation() {
    this.actionLoading = 'validation';
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.post<any>('/api/verification/start', {
      limit: Number(this.validationLimit) || 1000,
      skipSmtp: this.skipSmtp,
    }).subscribe({
      next: (response) => {
        this.actionMessage = `Queued ${response.jobsAdded || 0} pending emails for validation.`;
        this.actionLoading = '';
        this.loadValidation();
      },
      error: () => {
        this.errorMessage = 'Pending validation could not be started.';
        this.actionLoading = '';
      }
    });
  }

  refreshQueue() {
    this.actionLoading = 'refresh';
    forkJoin({
      queue: this.http.get<any>('/api/verification/queue-stats'),
      typo: this.http.get<any>('/api/verification/typo-audit/full-scan/status'),
    }).subscribe({
      next: (response) => {
        this.queue = response.queue.queue || this.queue;
        this.typoScanJob = response.typo.job || null;
        this.actionLoading = '';
        this.lastUpdated = new Date();
      },
      error: () => {
        this.errorMessage = 'Queue status could not be refreshed.';
        this.actionLoading = '';
      }
    });
  }

  refreshBounceRecovery() {
    this.actionLoading = 'bounce-refresh';
    this.errorMessage = '';

    forkJoin({
      summary: this.http.get<any>('/api/verification/bounce-recovery/summary'),
      list: this.http.get<any>(this.getBounceRecoveryUrl()),
    }).subscribe({
      next: (response) => {
        this.bounceSummary = response.summary.summary || this.bounceSummary;
        this.bounceTotal = Number(response.list.result?.total || 0);
        this.bounceCandidates = response.list.result?.items || [];
        this.actionLoading = '';
        this.lastUpdated = new Date();
      },
      error: () => {
        this.errorMessage = 'Bounce recovery could not be refreshed.';
        this.actionLoading = '';
      }
    });
  }

  searchBounceRecovery() {
    this.bounceOffset = 0;
    this.refreshBounceRecovery();
  }

  setBounceStatus(status: 'pending' | 'approved' | 'ignored') {
    this.bounceStatus = status;
    this.bounceOffset = 0;
    this.refreshBounceRecovery();
  }

  moveBouncePage(direction: -1 | 1) {
    const nextOffset = this.bounceOffset + direction * this.bounceLimit;
    this.bounceOffset = Math.max(0, Math.min(nextOffset, Math.max(this.bounceTotal - 1, 0)));
    this.refreshBounceRecovery();
  }

  approveBounceCandidate(candidate: BounceRecoveryCandidate) {
    this.actionLoading = `bounce-approve-${candidate.id}`;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.post<any>(`/api/verification/bounce-recovery/${candidate.id}/approve`, {}).subscribe({
      next: (response) => {
        const queued = response.result?.validationQueued ? 'Queued for validation.' : 'Validation was not queued.';
        this.actionMessage = `Approved recovery candidate #${candidate.id}. ${queued}`;
        this.actionLoading = '';
        this.refreshBounceRecovery();
      },
      error: () => {
        this.errorMessage = `Could not approve candidate #${candidate.id}.`;
        this.actionLoading = '';
      }
    });
  }

  startBounceSuggestionEdit(candidate: BounceRecoveryCandidate) {
    this.editingBounceId = candidate.id;
    this.bounceEditEmail = candidate.suggestedEmail || '';
    this.actionMessage = '';
    this.errorMessage = '';
  }

  cancelBounceSuggestionEdit() {
    this.editingBounceId = null;
    this.bounceEditEmail = '';
  }

  saveBounceSuggestion(candidate: BounceRecoveryCandidate) {
    const suggestedEmail = this.bounceEditEmail.trim().toLowerCase();

    if (!suggestedEmail || !suggestedEmail.includes('@')) {
      this.errorMessage = 'Enter a valid suggested email before saving.';
      return;
    }

    this.actionLoading = `bounce-edit-${candidate.id}`;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.post<any>(`/api/verification/bounce-recovery/${candidate.id}/suggestion`, {
      suggestedEmail,
      note: 'Manual suggestion edit from Bounce recovery UI',
    }).subscribe({
      next: (response) => {
        if (!response.result?.updated) {
          this.errorMessage = response.result?.reason || `Could not update candidate #${candidate.id}.`;
          this.actionLoading = '';
          return;
        }

        this.actionMessage = `Updated suggestion for candidate #${candidate.id}.`;
        this.editingBounceId = null;
        this.bounceEditEmail = '';
        this.actionLoading = '';
        this.refreshBounceRecovery();
      },
      error: () => {
        this.errorMessage = `Could not update candidate #${candidate.id}.`;
        this.actionLoading = '';
      }
    });
  }

  ignoreBounceCandidate(candidate: BounceRecoveryCandidate) {
    this.actionLoading = `bounce-ignore-${candidate.id}`;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.post<any>(`/api/verification/bounce-recovery/${candidate.id}/ignore`, {}).subscribe({
      next: () => {
        this.actionMessage = `Ignored recovery candidate #${candidate.id}.`;
        this.actionLoading = '';
        this.refreshBounceRecovery();
      },
      error: () => {
        this.errorMessage = `Could not ignore candidate #${candidate.id}.`;
        this.actionLoading = '';
      }
    });
  }

  copyBounceEmail(candidate: BounceRecoveryCandidate) {
    const email = candidate.suggestedEmail || candidate.bouncedEmail;

    if (!email || !navigator?.clipboard) {
      this.errorMessage = 'Email could not be copied.';
      return;
    }

    navigator.clipboard.writeText(email).then(() => {
      this.actionMessage = `Copied ${email}.`;
    }).catch(() => {
      this.errorMessage = 'Email could not be copied.';
    });
  }

  onRecoveryExportSegmentChange() {
    this.recoveryExportBatch = 1;
    this.recoveryExportPreview = null;
  }

  loadRecoveryExportPreview() {
    this.recoveryExportLoading = true;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.get<RecoveryExportPreview>('/api/emails/neverbounce/preview', {
      params: this.getRecoveryExportParams(),
    }).subscribe({
      next: (response) => {
        this.recoveryExportPreview = response;
        this.actionMessage = `Recovery export preview loaded: ${response.rows.length} rows in batch ${response.batch} of ${response.totalBatches || 1}.`;
        this.recoveryExportLoading = false;
      },
      error: () => {
        this.errorMessage = 'Recovery export preview could not be loaded.';
        this.recoveryExportLoading = false;
      },
    });
  }

  downloadRecoveryExportCsv() {
    this.recoveryExportDownloading = true;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.get('/api/emails/neverbounce/export.csv', {
      params: this.getRecoveryExportParams(),
      responseType: 'blob',
      observe: 'response',
    }).subscribe({
      next: (response) => {
        const blob = response.body || new Blob([], { type: 'text/csv' });
        const disposition = response.headers.get('content-disposition') || '';
        const filenameMatch = disposition.match(/filename="([^"]+)"/);
        const filename = filenameMatch?.[1] || this.getRecoveryExportFilename();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        window.URL.revokeObjectURL(url);
        this.actionMessage = `Downloaded ${filename}. Import the ZeroBounce/NeverBounce result after verification.`;
        this.recoveryExportDownloading = false;
      },
      error: () => {
        this.errorMessage = 'Recovery export CSV could not be downloaded.';
        this.recoveryExportDownloading = false;
      },
    });
  }

  previewExternalResultImport() {
    this.runExternalResultImport(true);
  }

  applyExternalResultImport() {
    if (!confirm('Apply external validation results to email statuses and send eligibility?')) {
      return;
    }

    this.runExternalResultImport(false);
  }

  refreshZeroBounceCredits() {
    this.zeroBounceLoading = 'credits';
    this.errorMessage = '';

    this.http.get<any>('/api/verification/zerobounce/credits').subscribe({
      next: (response) => {
        this.zeroBounceCredits = response.result || this.zeroBounceCredits;
        this.zeroBounceLoading = '';
      },
      error: () => {
        this.errorMessage = 'ZeroBounce credits could not be loaded.';
        this.zeroBounceLoading = '';
      },
    });
  }

  previewZeroBounceSegment() {
    this.zeroBounceLoading = 'preview';
    this.zeroBounceRunResult = null;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.get<any>('/api/verification/zerobounce/segments/preview', {
      params: {
        segment: this.zeroBounceSegment,
        limit: String(this.normalizeZeroBounceLimit()),
      },
    }).subscribe({
      next: (response) => {
        this.zeroBouncePreview = response.result || null;
        this.zeroBounceCredits = {
          configured: this.zeroBouncePreview?.configured || false,
          credits: this.zeroBouncePreview?.credits ?? this.zeroBounceCredits.credits,
          validKey: this.zeroBouncePreview?.validKey ?? this.zeroBounceCredits.validKey,
        };
        this.actionMessage = `ZeroBounce preview ready: ${this.zeroBouncePreview?.rows.length || 0} emails in this batch.`;
        this.zeroBounceLoading = '';
      },
      error: () => {
        this.errorMessage = 'ZeroBounce preview could not be loaded.';
        this.zeroBounceLoading = '';
      },
    });
  }

  runZeroBounceValidation() {
    if (!this.zeroBouncePreview) {
      this.errorMessage = 'Preview the ZeroBounce segment before running validation.';
      return;
    }

    if (!confirm(`Validate ${this.zeroBouncePreview.rows.length} emails with ZeroBounce API?`)) {
      return;
    }

    this.zeroBounceLoading = 'run';
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.post<any>('/api/verification/zerobounce/validate', {
      segment: this.zeroBounceSegment,
      limit: this.normalizeZeroBounceLimit(),
      dryRun: false,
    }).subscribe({
      next: (response) => {
        this.zeroBounceRunResult = response.result || null;
        this.externalImportPreview = this.zeroBounceRunResult?.importResult || this.externalImportPreview;
        this.actionMessage = `ZeroBounce validation applied: ${this.zeroBounceRunResult?.importResult?.updated || 0} email rows updated.`;
        this.zeroBounceLoading = '';
        this.loadValidation();
      },
      error: (error) => {
        this.errorMessage = error?.error?.message || 'ZeroBounce validation could not be completed.';
        this.zeroBounceLoading = '';
      },
    });
  }

  downloadDomainBatch(domain: string) {
    const params = new URLSearchParams({
      segment: 'domain',
      domain,
      batch: '1',
      limit: '1000',
    });
    window.location.href = `/api/emails/neverbounce/export.csv?${params.toString()}`;
  }

  getStatusCount(status: string): number {
    return Number(this.overview.byStatus?.[status] || 0);
  }

  getQueuePressure(): number {
    const total = this.queue.waiting + this.queue.active + this.queue.failed;
    if (!total) {
      return 0;
    }

    return Math.min(100, Math.round(((this.queue.waiting + this.queue.active) / total) * 100));
  }

  getTypoScanLabel(): string {
    if (!this.typoScanJob) {
      return 'Idle';
    }

    if (this.typoScanJob.state === 'completed') {
      return 'Completed';
    }

    if (this.typoScanJob.state === 'active') {
      return 'Running';
    }

    return this.typoScanJob.state || 'Queued';
  }

  getTypoScanCount(scope: 'emails' | 'customers', key: 'scanned' | 'matches'): number {
    const progress = this.typoScanJob?.progress || this.typoScanJob?.result || {};
    return Number(progress?.[scope]?.[key] || 0);
  }

  getBounceStatusCount(status: 'pending' | 'approved' | 'ignored'): number {
    return Number(this.bounceSummary.byStatus?.[status] || 0);
  }

  getBounceReasonCount(reason: 'domain_typo' | 'name_localpart_typo'): number {
    return Number(this.bounceSummary.pendingByReason?.[reason] || 0);
  }

  getBouncePageLabel(): string {
    if (!this.bounceTotal) {
      return '0 - 0 / 0';
    }

    const start = this.bounceOffset + 1;
    const end = Math.min(this.bounceOffset + this.bounceLimit, this.bounceTotal);
    return `${start} - ${end} / ${this.bounceTotal}`;
  }

  getBounceReasonLabel(reason: BounceRecoveryCandidate['reason']): string {
    return reason === 'name_localpart_typo' ? 'Name typo' : 'Domain typo';
  }

  getBounceSourceLabel(source: string): string {
    return this.formatMapLabel(source || 'unknown');
  }

  getBounceResolutionLabel(candidate: BounceRecoveryCandidate): string {
    if (candidate.status === 'approved') {
      return 'Queued for validation';
    }

    if (candidate.status === 'ignored') {
      return 'Marked unsafe';
    }

    return candidate.existingSuggestedStatus
      ? this.formatMapLabel(candidate.existingSuggestedStatus)
      : 'Awaiting decision';
  }

  trackBounceCandidate(_: number, candidate: BounceRecoveryCandidate): number {
    return candidate.id;
  }

  formatMapLabel(value: string): string {
    return String(value || 'unknown')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (match) => match.toUpperCase());
  }

  getRecoveryExportSegmentLabel(segment: RecoveryExportSegment): string {
    const labels: Record<RecoveryExportSegment, string> = {
      recovery_all: 'All approved recovery',
      recovery_domain_typo: 'Domain typo recovery',
      recovery_name_typo: 'Name typo recovery',
      recovery_manual_edit: 'Manual edits',
    };

    return labels[segment] || this.formatMapLabel(segment);
  }

  getExternalImportStatusRows(): Array<{ key: string; count: number }> {
    return this.toMapRows(this.externalImportPreview?.byMappedStatus || {}, 8);
  }

  getZeroBounceSegmentLabel(segment: ZeroBounceSegment): string {
    const labels: Record<ZeroBounceSegment, string> = {
      smtp_failed_internal: 'SMTP failed internally',
      typo_resolved: 'Resolved typo recovery',
      external_review: 'External review queue',
    };

    return labels[segment] || this.formatMapLabel(segment);
  }

  getZeroBounceStatusRows(): Array<{ key: string; count: number }> {
    return this.toMapRows(this.zeroBounceRunResult?.importResult?.byMappedStatus || {}, 8);
  }

  getElasticDoNotSendShare(): number {
    const total = Number(this.suppressionOverview.totals.doNotSend || 0);
    if (!total) {
      return 0;
    }

    return Math.round((Number(this.suppressionOverview.totals.elasticDoNotSendRows || 0) / total) * 100);
  }

  getGmailSignalTotal(): number {
    return (
      Number(this.suppressionOverview.totals.gmailBounces || 0) +
      Number(this.suppressionOverview.totals.gmailUnsubscribes || 0) +
      Number(this.suppressionOverview.totals.gmailAbuse || 0)
    );
  }

  private getBounceRecoveryUrl(): string {
    const params = new URLSearchParams({
      status: this.bounceStatus,
      limit: String(this.bounceLimit),
      offset: String(this.bounceOffset),
    });

    if (this.bounceSearch.trim()) {
      params.set('search', this.bounceSearch.trim());
    }

    return `/api/verification/bounce-recovery?${params.toString()}`;
  }

  private getRecoveryExportParams(): Record<string, string> {
    return {
      segment: this.recoveryExportSegment,
      batch: String(Math.max(Number(this.recoveryExportBatch) || 1, 1)),
      limit: String(Math.min(Math.max(Number(this.recoveryExportLimit) || 1000, 1), 1000)),
    };
  }

  private getRecoveryExportFilename(): string {
    return `external-validation-${this.recoveryExportSegment.replace(/_/g, '-')}-batch-${String(this.recoveryExportBatch).padStart(3, '0')}.csv`;
  }

  private normalizeZeroBounceLimit(): number {
    const parsed = Number(this.zeroBounceLimit) || 35;
    return Math.min(Math.max(Math.floor(parsed), 1), 100);
  }

  private runExternalResultImport(dryRun: boolean) {
    if (!this.externalImportCsv.trim()) {
      this.errorMessage = 'Paste the external validation CSV before importing.';
      return;
    }

    this.externalImportLoading = true;
    this.actionMessage = '';
    this.errorMessage = '';

    this.http.post<any>(`/api/verification/external-results/${dryRun ? 'preview' : 'import'}`, {
      provider: this.externalImportProvider,
      csv: this.externalImportCsv,
      sourceSegment: 'bounce_recovery',
      batchName: `${this.externalImportProvider} recovery result import`,
    }).subscribe({
      next: (response) => {
        this.externalImportPreview = response.result || null;
        this.actionMessage = dryRun
          ? `External result preview ready: ${this.externalImportPreview?.matched || 0} matched rows.`
          : `External results imported: ${this.externalImportPreview?.updated || 0} email rows updated.`;
        this.externalImportLoading = false;
        if (!dryRun) {
          this.loadValidation();
        }
      },
      error: () => {
        this.errorMessage = 'External validation results could not be processed.';
        this.externalImportLoading = false;
      },
    });
  }

  private createEmptyOverview(): IntakeOverview {
    return {
      totals: {
        emails: 0,
        pendingValidation: 0,
        safeToSend: 0,
        riskyOrReview: 0,
        doNotSend: 0,
        typoReview: 0,
        bounceInvalid: 0,
      },
      byStatus: {},
      topCommercialDomains: [],
    };
  }

  private createEmptySuppressionOverview(): SuppressionOverview {
    return {
      totals: {
        doNotSend: 0,
        elasticSuppressionRows: 0,
        elasticDoNotSendRows: 0,
        bounceAfterUnsubscribe: 0,
        gmailBounces: 0,
        gmailUnsubscribes: 0,
        gmailAbuse: 0,
        elasticEvents: 0,
      },
      doNotSendByReason: {},
      doNotSendBySource: {},
      elasticEventsByStatus: {},
      elasticEventsByReason: {},
      gmailByCategory: {},
    };
  }

  private setSuppressionOverview(overview: SuppressionOverview) {
    this.suppressionOverview = overview;
    this.doNotSendReasonRows = this.toMapRows(overview.doNotSendByReason, 6);
    this.doNotSendSourceRows = this.toMapRows(overview.doNotSendBySource, 6);
    this.elasticEventStatusRows = this.toMapRows(overview.elasticEventsByStatus, 6);
    this.elasticEventReasonRows = this.toMapRows(overview.elasticEventsByReason, 6);
    this.gmailSignalRows = this.toMapRows(overview.gmailByCategory, 6);
  }

  private toMapRows(map: Record<string, number>, limit: number): MapRow[] {
    return Object.entries(map || {})
      .map(([key, count]) => ({ key, count: Number(count || 0) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
}
