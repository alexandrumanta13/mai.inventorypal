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
    }).subscribe({
      next: (response) => {
        this.overview = response.overview.overview || this.createEmptyOverview();
        this.queue = response.queue.queue || this.queue;
        this.typoScanJob = response.typo.job || null;
        this.bounceSummary = response.bounceSummary.summary || this.bounceSummary;
        this.bounceTotal = Number(response.bounceList.result?.total || 0);
        this.bounceCandidates = response.bounceList.result?.items || [];
        this.setSuppressionOverview(response.suppression.overview || this.createEmptySuppressionOverview());
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
