import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { VerificationStatus } from '@shared/enums/verification-status.enum';
import { Email } from '@modules/emails/entities/email.entity';

@Entity('verification_history')
@Index('idx_email', ['emailId'])
@Index('idx_verified_at', ['verifiedAt'])
@Index('idx_final_status', ['finalStatus'])
export class VerificationHistory {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  emailId: number;

  // Layer results
  @Column({ type: 'boolean', nullable: true })
  syntaxValid: boolean;

  @Column({ type: 'boolean', nullable: true })
  dnsValid: boolean;

  @Column({ type: 'boolean', nullable: true })
  smtpValid: boolean;

  @Column({ type: 'boolean', nullable: true })
  isDisposable: boolean;

  @Column({ type: 'boolean', nullable: true })
  isRoleBased: boolean;

  // Final result
  @Column({
    type: 'enum',
    enum: VerificationStatus,
  })
  finalStatus: VerificationStatus;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  qualityScore: number;

  // Audit details
  @Column({ type: 'json', nullable: true })
  verificationDetails: any;

  @Column({ type: 'int', nullable: true })
  durationMs: number;

  @CreateDateColumn({ type: 'timestamp' })
  verifiedAt: Date;

  // Relations
  @ManyToOne(() => Email, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'emailId' })
  email: Email;
}
