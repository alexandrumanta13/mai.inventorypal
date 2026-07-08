import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Email } from '@modules/emails/entities/email.entity';
import { Customer } from '@modules/customers/entities/customer.entity';
import { EmailValidationBatch } from './entities/email-validation-batch.entity';
import { EmailValidationEvent } from './entities/email-validation-event.entity';
import { BounceRecoveryCandidate } from './entities/bounce-recovery-candidate.entity';
import { VerificationHistory } from './entities/verification-history.entity';
import { EmailVerifierService } from './services/email-verifier.service';
import { ValidationIntakeGateService } from './services/validation-intake-gate.service';
import { BounceRecoveryService } from './services/bounce-recovery.service';
import { ElasticEmailIngestionService } from './services/elastic-email-ingestion.service';
import { ExternalValidationImportService } from './services/external-validation-import.service';
import { SyntaxValidator } from './validators/syntax.validator';
import { DnsValidator } from './validators/dns.validator';
import { SmtpValidator } from './validators/smtp.validator';
import { FilterValidator } from './validators/filter.validator';
import { VerificationProcessor } from './processors/verification.processor';
import { TypoScanProcessor } from './processors/typo-scan.processor';
import { VerificationController } from './controllers/verification.controller';
import { shouldRunWorkers } from '../../config/process-role';
import { EmailsModule } from '@modules/emails/emails.module';

const verificationWorkerProviders = shouldRunWorkers()
  ? [VerificationProcessor, TypoScanProcessor]
  : [];

/**
 * Email Verification Module
 *
 * Provides 4-layer email verification:
 * 1. Syntax Validation (RFC 5322)
 * 2. DNS/MX Record Validation (with Redis cache)
 * 3. SMTP Handshake Validation (NO email sending)
 * 4. Filter Validation (disposable, role-based, typos)
 *
 * Uses BullMQ for async processing with 50 concurrent workers
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Email,
      Customer,
      VerificationHistory,
      EmailValidationBatch,
      EmailValidationEvent,
      BounceRecoveryCandidate,
    ]),
    EmailsModule,
    BullModule.registerQueue({
      name: 'email-verification',
    }),
    BullModule.registerQueue({
      name: 'typo-scan',
    }),
  ],
  controllers: [VerificationController],
  providers: [
    // Validators
    SyntaxValidator,
    DnsValidator,
    SmtpValidator,
    FilterValidator,

    // Services
    EmailVerifierService,
    ValidationIntakeGateService,
    BounceRecoveryService,
    ElasticEmailIngestionService,
    ExternalValidationImportService,

    // Processors
    ...verificationWorkerProviders,
  ],
  exports: [
    EmailVerifierService,
    ValidationIntakeGateService,
    BounceRecoveryService,
    ElasticEmailIngestionService,
    ExternalValidationImportService,
  ],
})
export class EmailVerificationModule {}
