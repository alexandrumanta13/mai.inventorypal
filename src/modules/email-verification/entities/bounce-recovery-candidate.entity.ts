import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import { Customer } from '@modules/customers/entities/customer.entity';

export enum BounceRecoveryStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  IGNORED = 'ignored',
}

export enum BounceRecoveryReason {
  DOMAIN_TYPO = 'domain_typo',
  NAME_LOCALPART_TYPO = 'name_localpart_typo',
}

@Entity('bounce_recovery_candidates')
@Index('idx_bounce_recovery_status', ['status'])
@Index('idx_bounce_recovery_bounced_email', ['bouncedEmail'])
@Index('idx_bounce_recovery_suggested_email', ['suggestedEmail'])
@Index('idx_bounce_recovery_email', ['emailId'])
@Index('idx_bounce_recovery_customer', ['customerId'])
@Index('idx_bounce_recovery_unique_pending', ['bouncedEmail', 'suggestedEmail', 'status'], {
  unique: true,
})
export class BounceRecoveryCandidate {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  emailId: number;

  @Column({ type: 'bigint', nullable: true })
  customerId: number;

  @Column({ type: 'varchar', length: 255 })
  bouncedEmail: string;

  @Column({ type: 'varchar', length: 255 })
  suggestedEmail: string;

  @Column({
    type: 'enum',
    enum: BounceRecoveryReason,
  })
  reason: BounceRecoveryReason;

  @Column({
    type: 'enum',
    enum: ['high', 'medium'],
    default: 'medium',
  })
  confidence: 'high' | 'medium';

  @Column({
    type: 'enum',
    enum: BounceRecoveryStatus,
    default: BounceRecoveryStatus.PENDING,
  })
  status: BounceRecoveryStatus;

  @Column({ type: 'varchar', length: 100, default: 'gmail_bounce' })
  source: string;

  @Column({ type: 'timestamp', nullable: true })
  bouncedAt: Date;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @Column({ type: 'text', nullable: true })
  note: string;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  @ManyToOne(() => Email, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'emailId' })
  email: Email;

  @ManyToOne(() => Customer, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;
}
