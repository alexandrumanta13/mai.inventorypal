import { Injectable } from '@nestjs/common';

export interface ScanProgress {
  isScanning: boolean;
  phase: 'smart' | 'unsubscribe' | 'orders' | 'abuse' | 'idle';
  totalScanned: number;
  currentBatch: number;
  estimatedTotal: number;
  unsubscribes: number;
  bounces: number;
  orders: number;
  abuse: number;
  startTime: Date | null;
  estimatedTimeRemaining: number | null; // seconds
}

/**
 * Service pentru tracking progresul scanării Gmail în timp real
 * Folosește in-memory storage pentru a fi accesibil din mai multe locuri
 */
@Injectable()
export class ScanProgressService {
  private progress: ScanProgress = {
    isScanning: false,
    phase: 'idle',
    totalScanned: 0,
    currentBatch: 0,
    estimatedTotal: 0,
    unsubscribes: 0,
    bounces: 0,
    orders: 0,
    abuse: 0,
    startTime: null,
    estimatedTimeRemaining: null,
  };

  /**
   * Inițializează un scan nou
   */
  startScan(estimatedTotal: number): void {
    this.progress = {
      isScanning: true,
      phase: 'unsubscribe',
      totalScanned: 0,
      currentBatch: 0,
      estimatedTotal,
      unsubscribes: 0,
      bounces: 0,
      orders: 0,
      abuse: 0,
      startTime: new Date(),
      estimatedTimeRemaining: null,
    };
  }

  /**
   * Update progress pentru un batch nou scanat
   */
  updateProgress(data: {
    phase?: 'smart' | 'unsubscribe' | 'orders' | 'abuse';
    scanned?: number;
    unsubscribes?: number;
    bounces?: number;
    orders?: number;
    abuse?: number;
  }): void {
    if (data.phase) {
      this.progress.phase = data.phase;
    }

    if (data.scanned) {
      this.progress.totalScanned += data.scanned;
      this.progress.currentBatch++;
    }

    if (data.unsubscribes) {
      this.progress.unsubscribes += data.unsubscribes;
    }

    if (data.bounces) {
      this.progress.bounces += data.bounces;
    }

    if (data.orders) {
      this.progress.orders += data.orders;
    }

    if (data.abuse) {
      this.progress.abuse += data.abuse;
    }

    // Calculate estimated time remaining
    if (this.progress.startTime && this.progress.totalScanned > 0) {
      const elapsed = Date.now() - this.progress.startTime.getTime();
      const rate = this.progress.totalScanned / (elapsed / 1000); // emails/second
      const remaining = this.progress.estimatedTotal - this.progress.totalScanned;
      this.progress.estimatedTimeRemaining = Math.ceil(remaining / rate);
    }
  }

  /**
   * Finalizează scanul
   */
  finishScan(): void {
    this.progress.isScanning = false;
    this.progress.phase = 'idle';
    this.progress.estimatedTimeRemaining = 0;
  }

  /**
   * Returnează progresul curent
   */
  getProgress(): ScanProgress {
    return { ...this.progress };
  }

  /**
   * Calculează procentul de progres
   */
  getPercentage(): number {
    if (this.progress.estimatedTotal === 0) return 0;
    return Math.min(
      100,
      Math.round((this.progress.totalScanned / this.progress.estimatedTotal) * 100),
    );
  }

  /**
   * Reset progress (useful pentru erori)
   */
  reset(): void {
    this.progress = {
      isScanning: false,
      phase: 'idle',
      totalScanned: 0,
      currentBatch: 0,
      estimatedTotal: 0,
      unsubscribes: 0,
      bounces: 0,
      orders: 0,
      abuse: 0,
      startTime: null,
      estimatedTimeRemaining: null,
    };
  }
}
