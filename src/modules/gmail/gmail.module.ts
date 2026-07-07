import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { CustomersModule } from '../customers/customers.module';
import { EmailsModule } from '../emails/emails.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';
import { GmailService } from './services/gmail.service';
import { GmailController } from './controllers/gmail.controller';
import { GmailScanProcessor } from './processors/gmail-scan.processor';
import { GmailScheduledTask } from './services/gmail-scheduled-task.service';
import { LLMCategorizationService } from './services/llm-categorization.service';
import { ScanProgressService } from './services/scan-progress.service';
import { Email } from '../emails/entities/email.entity';
import { FilterValidator } from '../email-verification/validators/filter.validator';
import { shouldRunWorkers } from '../../config/process-role';

const gmailWorkerProviders = shouldRunWorkers()
  ? [GmailScanProcessor, GmailScheduledTask]
  : [];

/**
 * Gmail Module
 *
 * Provides Gmail integration for:
 * - OAuth2 authentication
 * - Email scanning (unsubscribe/bounce/orders/abuse detection)
 * - Background processing with BullMQ for large scans
 * - Daily automated scans via cron job
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Email]),
    CustomersModule,
    EmailsModule,
    EmailVerificationModule,
    BullModule.registerQueue({
      name: 'gmail-scan',
    }),
  ],
  controllers: [GmailController],
  providers: [
    GmailService,
    LLMCategorizationService,
    ScanProgressService,
    FilterValidator,
    ...gmailWorkerProviders,
  ],
  exports: [GmailService],
})
export class GmailModule {}
