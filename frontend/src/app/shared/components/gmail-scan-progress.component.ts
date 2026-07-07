import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

interface ScanProgress {
  isScanning: boolean;
  phase: 'unsubscribe' | 'orders' | 'abuse' | 'idle';
  totalScanned: number;
  currentBatch: number;
  estimatedTotal: number;
  unsubscribes: number;
  bounces: number;
  orders: number;
  abuse: number;
  startTime: string | null;
  estimatedTimeRemaining: number | null;
  percentage: number;
}

@Component({
  selector: 'app-gmail-scan-progress',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="progress && progress.isScanning" class="scan-toast" aria-live="polite">
      <div class="scan-toast__header">
        <div>
          <span>Live scan</span>
          <h3>Gmail progress</h3>
        </div>
        <strong>{{ progress.percentage }}%</strong>
      </div>

      <div class="scan-toast__bar">
        <div
          class="scan-toast__fill"
          [class.scan-toast__fill--unsubscribe]="progress.phase === 'unsubscribe'"
          [class.scan-toast__fill--orders]="progress.phase === 'orders'"
          [class.scan-toast__fill--abuse]="progress.phase === 'abuse'"
          [style.width.%]="progress.percentage">
        </div>
      </div>

      <div class="scan-toast__phase">
        <span>Phase</span>
        <strong>{{ getPhaseLabel(progress.phase) }}</strong>
      </div>

      <div class="scan-toast__stats">
        <div>
          <span>Scanned</span>
          <strong>{{ progress.totalScanned | number }}</strong>
          <small>of ~{{ progress.estimatedTotal | number }}</small>
        </div>
        <div>
          <span>Unsubs</span>
          <strong>{{ progress.unsubscribes | number }}</strong>
        </div>
        <div>
          <span>Bounces</span>
          <strong>{{ progress.bounces | number }}</strong>
        </div>
        <div>
          <span>Orders</span>
          <strong>{{ progress.orders | number }}</strong>
        </div>
        <div>
          <span>Abuse</span>
          <strong>{{ progress.abuse | number }}</strong>
        </div>
        <div *ngIf="progress.estimatedTimeRemaining">
          <span>Left</span>
          <strong>{{ formatTime(progress.estimatedTimeRemaining) }}</strong>
        </div>
      </div>

      <div class="scan-toast__live">
        <span></span>
        Live scanning
      </div>
    </div>

    <div *ngIf="showCompleteNotification"
         class="scan-toast scan-toast--complete">
      <div class="scan-toast__complete">
        <svg width="24" height="24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <div>
          <h4>Scan complete</h4>
          <p>
            Processed {{ lastProgress?.totalScanned | number }} emails
          </p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .scan-toast {
      position: fixed;
      right: 1rem;
      bottom: 1rem;
      z-index: 70;
      width: min(420px, calc(100vw - 2rem));
      padding: 1rem;
      color: var(--color-text);
      background: rgba(255, 255, 255, 0.96);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      backdrop-filter: blur(16px);
    }
    .scan-toast__header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: flex-start;
      margin-bottom: 0.85rem;
    }
    .scan-toast__header span,
    .scan-toast__phase span,
    .scan-toast__stats span {
      color: var(--color-muted);
      font-size: 0.7rem;
      font-weight: 900;
      text-transform: uppercase;
    }
    .scan-toast__header h3 {
      margin: 0.1rem 0 0;
      font-size: 1rem;
      font-weight: 900;
    }
    .scan-toast__header strong {
      color: var(--color-primary);
      font-size: 1.2rem;
      font-weight: 900;
    }
    .scan-toast__bar {
      height: 10px;
      overflow: hidden;
      background: #edf2f7;
      border-radius: 999px;
    }
    .scan-toast__fill {
      height: 100%;
      background: var(--color-primary);
      border-radius: inherit;
      transition: width 0.3s ease;
    }
    .scan-toast__fill--unsubscribe { background: var(--color-info); }
    .scan-toast__fill--orders { background: var(--color-success); }
    .scan-toast__fill--abuse { background: var(--color-danger); }
    .scan-toast__phase {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin: 0.9rem 0;
    }
    .scan-toast__phase strong {
      font-size: 0.82rem;
    }
    .scan-toast__stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.5rem;
    }
    .scan-toast__stats div {
      min-width: 0;
      padding: 0.65rem;
      background: var(--color-surface-muted);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .scan-toast__stats strong,
    .scan-toast__stats small {
      display: block;
    }
    .scan-toast__stats strong {
      margin-top: 0.2rem;
      font-weight: 900;
    }
    .scan-toast__stats small {
      color: var(--color-muted);
      font-size: 0.68rem;
    }
    .scan-toast__live {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      margin-top: 0.9rem;
      color: var(--color-muted);
      font-size: 0.74rem;
      font-weight: 800;
    }
    .scan-toast__live span {
      width: 8px;
      height: 8px;
      background: var(--color-success);
      border-radius: 999px;
      animation: pulse 1s ease-in-out infinite;
    }
    .scan-toast--complete {
      border-color: #bbf7d0;
      background: var(--color-success-soft);
      animation: fade-in 0.3s ease-out;
    }
    .scan-toast__complete {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      color: var(--color-success);
    }
    .scan-toast__complete h4 {
      margin: 0;
      font-weight: 900;
    }
    .scan-toast__complete p {
      margin: 0.15rem 0 0;
      color: var(--color-success);
    }
    @keyframes fade-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.45); opacity: 0.55; }
    }
  `]
})
export class GmailScanProgressComponent implements OnInit, OnDestroy {
  progress: ScanProgress | null = null;
  showCompleteNotification = false;
  lastProgress: ScanProgress | null = null;
  private eventSource: EventSource | null = null;

  ngOnInit(): void {
    this.connectToProgressStream();
  }

  ngOnDestroy(): void {
    this.disconnectFromProgressStream();
  }

  private connectToProgressStream(): void {
    // Connect to SSE endpoint
    this.eventSource = new EventSource('/api/gmail/scan/progress');

    this.eventSource.onmessage = (event) => {
      const data: ScanProgress = JSON.parse(event.data);

      // Check if scan just completed
      if (this.progress?.isScanning && !data.isScanning) {
        this.lastProgress = data;
        this.showCompleteNotification = true;

        // Hide notification after 3 seconds
        setTimeout(() => {
          this.showCompleteNotification = false;
        }, 3000);
      }

      this.progress = data;
    };

    this.eventSource.onerror = (error) => {
      console.error('SSE connection error:', error);
      // Reconnect after 5 seconds
      setTimeout(() => {
        this.disconnectFromProgressStream();
        this.connectToProgressStream();
      }, 5000);
    };
  }

  private disconnectFromProgressStream(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  getPhaseLabel(phase: string): string {
    switch (phase) {
      case 'unsubscribe': return 'Unsubscribes & Bounces';
      case 'orders': return 'Order Confirmations';
      case 'abuse': return 'Abusive Content';
      case 'idle': return 'Idle';
      default: return phase;
    }
  }

  formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${Math.round(seconds)}s`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${minutes}m ${secs}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }
}
