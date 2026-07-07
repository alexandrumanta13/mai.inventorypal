import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import {
  ImportJobSourceType,
  ImportJobStatus,
} from '@shared/enums/import-source.enum';

@Entity('import_jobs')
@Index('idx_status', ['status'])
@Index('idx_source_type', ['sourceType'])
@Index('idx_created_at', ['createdAt'])
export class ImportJob {
  @PrimaryGeneratedColumn('increment')
  id: number;

  @Column({
    type: 'enum',
    enum: ImportJobSourceType,
  })
  sourceType: ImportJobSourceType;

  @Column({
    type: 'enum',
    enum: ImportJobStatus,
    default: ImportJobStatus.PENDING,
  })
  status: ImportJobStatus;

  // Progress tracking
  @Column({ type: 'int', default: 0 })
  totalFiles: number;

  @Column({ type: 'int', default: 0 })
  processedFiles: number;

  @Column({ type: 'int', default: 0 })
  totalRecords: number;

  @Column({ type: 'int', default: 0 })
  processedRecords: number;

  @Column({ type: 'int', default: 0 })
  importedEmails: number;

  @Column({ type: 'int', default: 0 })
  duplicateEmails: number;

  @Column({ type: 'int', default: 0 })
  invalidEmails: number;

  // Timing
  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
