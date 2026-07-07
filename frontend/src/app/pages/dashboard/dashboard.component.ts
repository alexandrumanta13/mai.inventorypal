import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, forkJoin, of } from 'rxjs';

interface EmailStats {
  total: number;
  byStatus: Record<string, number>;
}

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  total: number;
}

interface ImportJob {
  id: number;
  sourceType: string;
  status: string;
  importedEmails: number;
  duplicateEmails: number;
  createdAt: string;
  completedAt?: string;
}

interface Deliverability {
  safeToSend: number;
  risky: number;
  doNotSend: number;
}

interface SendEligibilityAnalytics {
  total: number;
  byEligibility: Record<string, number>;
  byReason: {
    reason: string;
    count: number;
    eligibility: string;
  }[];
  pendingOlderThan7Days: number;
  reviewNeedsAction: number;
}

interface GmailStatus {
  configured?: boolean;
  hasRefreshToken?: boolean;
  message?: string;
}

interface GmailScanStats {
  total: number;
  scanned: number;
  notScanned: number;
  byCategory: {
    unsubscribe: number;
    order: number;
    abuse: number;
    bounce: number;
    clean: number;
  };
  withNames: number;
  withMessageDate: number;
  recentScans: {
    last24h: number;
    last7days: number;
    last30days: number;
  };
}

@Component({
  selector: 'app-dashboard',
  standalone: false,
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  stats: EmailStats = { total: 0, byStatus: {} };
  queue: QueueStats = { waiting: 0, active: 0, completed: 0, failed: 0, total: 0 };
  importJobs: ImportJob[] = [];
  deliverability: Deliverability = { safeToSend: 0, risky: 0, doNotSend: 0 };
  sendEligibility: SendEligibilityAnalytics = {
    total: 0,
    byEligibility: {},
    byReason: [],
    pendingOlderThan7Days: 0,
    reviewNeedsAction: 0
  };
  gmailStatus: GmailStatus = {};
  gmailScanStats: GmailScanStats | null = null;

  loading = true;
  actionLoading = false;
  errorMessage = '';
  lastUpdated: Date | null = null;

  constructor(private http: HttpClient) {}

  ngOnInit() {
    this.loadCockpit();
  }

  loadCockpit() {
    this.loading = true;
    this.errorMessage = '';

    forkJoin({
      stats: this.http.get<EmailStats>('/api/emails/stats').pipe(catchError(() => of({ total: 0, byStatus: {} }))),
      queue: this.http.get<any>('/api/verification/queue-stats').pipe(catchError(() => of({ queue: this.queue }))),
      imports: this.http.get<any>('/api/imports/jobs').pipe(catchError(() => of({ jobs: [] }))),
      deliverability: this.http.get<Deliverability>('/api/emails/analytics/deliverability').pipe(catchError(() => of(this.deliverability))),
      sendEligibility: this.http.get<SendEligibilityAnalytics>('/api/emails/analytics/send-eligibility').pipe(catchError(() => of(this.sendEligibility))),
      gmail: this.http.get<GmailStatus>('/api/gmail/status').pipe(catchError(() => of({ configured: false, hasRefreshToken: false }))),
      gmailStats: this.http.get<{ stats: GmailScanStats }>('/api/gmail/scan/stats').pipe(catchError(() => of({ stats: null as any })))
    }).subscribe({
      next: ({ stats, queue, imports, deliverability, sendEligibility, gmail, gmailStats }) => {
        this.stats = stats;
        this.queue = queue.queue || this.queue;
        this.importJobs = (imports.jobs || []).slice(0, 6);
        this.deliverability = deliverability;
        this.sendEligibility = sendEligibility;
        this.gmailStatus = gmail;
        this.gmailScanStats = gmailStats.stats;
        this.lastUpdated = new Date();
        this.loading = false;
      },
      error: () => {
        this.errorMessage = 'Dashboard data could not be loaded.';
        this.loading = false;
      }
    });
  }

  startPendingVerification() {
    this.actionLoading = true;
    this.http.post('/api/verification/start', { limit: 1000, skipSmtp: false }).subscribe({
      next: () => {
        this.actionLoading = false;
        this.loadCockpit();
      },
      error: () => {
        this.actionLoading = false;
        this.errorMessage = 'Could not start verification queue.';
      }
    });
  }

  getStatusCount(status: string): number {
    return this.stats.byStatus[status] || 0;
  }

  getStatusPercentage(status: string): number {
    if (!this.stats.total) return 0;
    return Math.round((this.getStatusCount(status) / this.stats.total) * 100);
  }

  getQueueLoad(): number {
    if (!this.queue.total) return 0;
    return Math.min(100, Math.round(((this.queue.waiting + this.queue.active) / this.queue.total) * 100));
  }

  getDeliverabilityTotal(): number {
    return this.deliverability.safeToSend + this.deliverability.risky + this.deliverability.doNotSend;
  }

  getDeliverabilityPercentage(key: keyof Deliverability): number {
    const total = this.getDeliverabilityTotal();
    if (!total) return 0;
    return Math.round((this.deliverability[key] / total) * 100);
  }

  getEligibilityCount(eligibility: string): number {
    return this.sendEligibility.byEligibility?.[eligibility] || 0;
  }

  getEligibilityPercentage(eligibility: string): number {
    const total = this.sendEligibility.total || 0;
    if (!total) return 0;
    return Math.round((this.getEligibilityCount(eligibility) / total) * 100);
  }

  getEligibilityLabel(eligibility: string): string {
    const labels: Record<string, string> = {
      pending: 'Pending',
      review: 'Review',
      do_not_send: 'Blocked',
      safe_to_send: 'Safe'
    };
    return labels[eligibility] || eligibility;
  }

  getImportJobBadgeClass(status: string): string {
    const classes: Record<string, string> = {
      completed: 'ui-badge--success',
      running: 'ui-badge--info',
      pending: 'ui-badge--warning',
      failed: 'ui-badge--danger'
    };

    return classes[status] || 'ui-badge--muted';
  }

  getReasonLabel(reason: string): string {
    return reason.replace(/_/g, ' ');
  }

  isGmailReady(): boolean {
    return !!(this.gmailStatus.configured && this.gmailStatus.hasRefreshToken);
  }

  getGmailScanCoverage(): number {
    if (!this.gmailScanStats?.total) return 0;
    return Math.round((this.gmailScanStats.scanned / this.gmailScanStats.total) * 100);
  }

  trackImportJob(_: number, job: ImportJob): number {
    return job.id;
  }
}
