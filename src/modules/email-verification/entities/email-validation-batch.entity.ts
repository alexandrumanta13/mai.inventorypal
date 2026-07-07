import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import {
  EmailValidationBatchStatus,
  EmailValidationSourceSegment,
  ExternalValidationProvider,
} from '@shared/enums/email-validation.enum';
import { EmailValidationEvent } from './email-validation-event.entity';

@Entity('email_validation_batches')
@Index('idx_email_validation_batch_provider', ['provider'])
@Index('idx_email_validation_batch_status', ['status'])
@Index('idx_email_validation_batch_segment', ['sourceSegment'])
@Index('idx_email_validation_batch_provider_job', ['provider', 'providerJobId'])
export class EmailValidationBatch {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({
    type: 'enum',
    enum: ExternalValidationProvider,
    default: ExternalValidationProvider.UNKNOWN,
  })
  provider: ExternalValidationProvider;

  @Column({
    type: 'enum',
    enum: EmailValidationBatchStatus,
    default: EmailValidationBatchStatus.DRAFT,
  })
  status: EmailValidationBatchStatus;

  @Column({
    type: 'enum',
    enum: EmailValidationSourceSegment,
    default: EmailValidationSourceSegment.UNKNOWN,
  })
  sourceSegment: EmailValidationSourceSegment;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerJobId: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sourceDomain: string;

  @Column({ type: 'json', nullable: true })
  sourceFilter: any;

  @Column({ type: 'int', default: 0 })
  totalRecords: number;

  @Column({ type: 'int', default: 0 })
  submittedRecords: number;

  @Column({ type: 'int', default: 0 })
  processedRecords: number;

  @Column({ type: 'int', default: 0 })
  validCount: number;

  @Column({ type: 'int', default: 0 })
  invalidCount: number;

  @Column({ type: 'int', default: 0 })
  riskyCount: number;

  @Column({ type: 'int', default: 0 })
  unknownCount: number;

  @Column({ type: 'int', default: 0 })
  catchAllCount: number;

  @Column({ type: 'int', default: 0 })
  disposableCount: number;

  @Column({ type: 'json', nullable: true })
  metadata: any;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'timestamp', nullable: true })
  submittedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  @OneToMany(() => EmailValidationEvent, (event) => event.batch)
  events: EmailValidationEvent[];
}
