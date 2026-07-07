import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ImportSourceType } from '@shared/enums/import-source.enum';
import { Email } from './email.entity';

@Entity('email_sources')
@Index('idx_email', ['emailId'])
@Index('idx_source_type', ['sourceType'])
export class EmailSource {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  emailId: number;

  @Column({
    type: 'enum',
    enum: ImportSourceType,
  })
  sourceType: ImportSourceType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceIdentifier: string;

  // GDPR consent tracking
  @Column({ type: 'boolean', default: true })
  consentGiven: boolean;

  @Column({ type: 'timestamp', nullable: true })
  consentTimestamp: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => Email, (email) => email.sources, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'emailId' })
  email: Email;
}
