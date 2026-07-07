import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { ExternalValidationProvider, SendEligibility } from '@shared/enums/email-validation.enum';
import { EmailSource } from './email-source.entity';
import { Customer } from '@modules/customers/entities/customer.entity';

@Entity('emails')
@Index('idx_verification_status', ['verificationStatus'])
@Index('idx_quality_score', ['qualityScore'])
@Index('idx_last_verified', ['lastVerifiedAt'])
@Index('idx_email_customer', ['customerId'])
@Index('idx_email_domain', ['emailDomain'])
@Index('idx_send_eligibility', ['sendEligibility'])
export class Email {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'email_domain' })
  emailDomain: string;

  @Column({ type: 'bigint', nullable: true, name: 'customer_id' })
  customerId: number;

  // Metadata from import
  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  acquisitionSource: string;

  @Column({ type: 'date', nullable: true })
  acquisitionDate: Date;

  @Column({ type: 'varchar', length: 50, nullable: true })
  funnelStage: string;

  // Gmail scan data
  @Column({ type: 'varchar', length: 255, nullable: true })
  fullName: string;

  @Column({ type: 'timestamp', nullable: true })
  lastGmailScanDate: Date;

  @Column({ type: 'timestamp', nullable: true })
  gmailMessageDate: Date; // Data când a fost trimis emailul (pentru win-back)

  @Column({
    type: 'enum',
    enum: ['unsubscribe', 'order', 'abuse', 'bounce', 'clean'],
    nullable: true
  })
  gmailCategory: 'unsubscribe' | 'order' | 'abuse' | 'bounce' | 'clean';

  // Verification layer results
  @Column({ type: 'boolean', nullable: true })
  hasValidSyntax: boolean;

  @Column({ type: 'boolean', nullable: true })
  hasValidDns: boolean;

  @Column({ type: 'boolean', nullable: true })
  hasValidSmtp: boolean;

  @Column({ type: 'boolean', nullable: true })
  isDisposable: boolean;

  @Column({ type: 'boolean', nullable: true })
  isRoleBased: boolean;

  @Column({ type: 'boolean', nullable: true })
  hasTypo: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  typoSuggestion: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'accepted', 'ignored'],
    nullable: true,
  })
  typoResolutionStatus: 'pending' | 'accepted' | 'ignored';

  @Column({ type: 'varchar', length: 255, nullable: true })
  typoResolvedEmail: string;

  @Column({ type: 'timestamp', nullable: true })
  typoResolvedAt: Date;

  @Column({ type: 'text', nullable: true })
  typoResolutionNote: string;

  @Column({
    type: 'enum',
    enum: ['clean', 'typo'],
    nullable: true,
  })
  typoScanStatus: 'clean' | 'typo';

  @Column({ type: 'timestamp', nullable: true })
  typoScannedAt: Date;

  // Aggregated status
  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  verificationStatus: VerificationStatus;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  qualityScore: number;

  // SMTP details
  @Column({ type: 'varchar', length: 50, nullable: true })
  smtpResultCode: string;

  @Column({ type: 'text', nullable: true })
  smtpErrorMessage: string;

  @Column({
    type: 'enum',
    enum: SendEligibility,
    default: SendEligibility.PENDING,
  })
  sendEligibility: SendEligibility;

  @Column({ type: 'varchar', length: 100, nullable: true })
  doNotSendReason: string;

  @Column({
    type: 'enum',
    enum: ExternalValidationProvider,
    nullable: true,
  })
  lastValidationSource: ExternalValidationProvider;

  @Column({ type: 'timestamp', nullable: true })
  lastValidationAt: Date;

  // Timestamps
  @Column({ type: 'timestamp', nullable: true })
  lastVerifiedAt: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  // Relations
  @OneToMany(() => EmailSource, (source) => source.email)
  sources: EmailSource[];

  @ManyToOne(() => Customer, (customer) => customer.emails, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;
}
