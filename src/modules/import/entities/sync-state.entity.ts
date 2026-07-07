import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type SyncStateStatus = 'idle' | 'running' | 'failed';

@Entity('sync_states')
@Index('idx_sync_state_key', ['syncKey'], { unique: true })
@Index('idx_sync_state_source', ['sourceType'])
@Index('idx_sync_state_status', ['status'])
export class SyncState {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  syncKey: string;

  @Column({ type: 'varchar', length: 50 })
  sourceType: string;

  @Column({
    type: 'enum',
    enum: ['idle', 'running', 'failed'],
    default: 'idle',
  })
  status: SyncStateStatus;

  @Column({ type: 'timestamp', nullable: true })
  lastAttemptedSyncAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastSuccessfulSyncAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastCompletedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastOrderDate: Date;

  @Column({ type: 'bigint', nullable: true })
  lastOrderId: number;

  @Column({ type: 'int', nullable: true })
  lastJobId: number;

  @Column({ type: 'int', default: 0 })
  lastRowsSeen: number;

  @Column({ type: 'int', default: 0 })
  lastImportedEmails: number;

  @Column({ type: 'int', default: 0 })
  lastDuplicateEmails: number;

  @Column({ type: 'int', default: 0 })
  lastInvalidEmails: number;

  @Column({ type: 'int', default: 7 })
  overlapDays: number;

  @Column({ type: 'int', default: 365 })
  maxRecoveryDays: number;

  @Column({ type: 'text', nullable: true })
  lastErrorMessage: string;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
