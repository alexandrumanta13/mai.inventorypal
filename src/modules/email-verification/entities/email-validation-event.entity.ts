import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Email } from '@modules/emails/entities/email.entity';
import {
  EmailValidationMappedStatus,
  ExternalValidationProvider,
  SendEligibility,
} from '@shared/enums/email-validation.enum';
import { EmailValidationBatch } from './email-validation-batch.entity';

@Entity('email_validation_events')
@Index('idx_email_validation_event_batch', ['batchId'])
@Index('idx_email_validation_event_email', ['emailId'])
@Index('idx_email_validation_event_provider_status', ['provider', 'providerStatus'])
@Index('idx_email_validation_event_normalized', ['normalizedEmail'])
@Index('idx_email_validation_event_eligibility', ['sendEligibility'])
@Index('idx_email_validation_event_validated_at', ['validatedAt'])
export class EmailValidationEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', nullable: true })
  batchId: number;

  @Column({ type: 'bigint', nullable: true })
  emailId: number;

  @Column({
    type: 'enum',
    enum: ExternalValidationProvider,
    default: ExternalValidationProvider.UNKNOWN,
  })
  provider: ExternalValidationProvider;

  @Column({ type: 'varchar', length: 255 })
  inputEmail: string;

  @Column({ type: 'varchar', length: 255 })
  normalizedEmail: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  correctedEmail: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  providerStatus: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  providerSubStatus: string;

  @Column({
    type: 'enum',
    enum: EmailValidationMappedStatus,
    default: EmailValidationMappedStatus.PENDING,
  })
  mappedStatus: EmailValidationMappedStatus;

  @Column({
    type: 'enum',
    enum: SendEligibility,
    default: SendEligibility.PENDING,
  })
  sendEligibility: SendEligibility;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reasonCode: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  confidenceScore: number;

  @Column({ type: 'json', nullable: true })
  rawResponse: any;

  @Column({ type: 'timestamp', nullable: true })
  validatedAt: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  @ManyToOne(() => EmailValidationBatch, (batch) => batch.events, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'batchId' })
  batch: EmailValidationBatch;

  @ManyToOne(() => Email, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'emailId' })
  email: Email;
}
