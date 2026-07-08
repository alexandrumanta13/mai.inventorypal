import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Email } from './entities/email.entity';
import { EmailSource } from './entities/email-source.entity';
import { BounceRecoveryCandidate } from '../email-verification/entities/bounce-recovery-candidate.entity';
import { EmailsService } from './services/emails.service';
import { SendEligibilityService } from './services/send-eligibility.service';
import { EmailsController } from './controllers/emails.controller';
import { FilterValidator } from '../email-verification/validators/filter.validator';

@Module({
  imports: [TypeOrmModule.forFeature([Email, EmailSource, BounceRecoveryCandidate])],
  controllers: [EmailsController],
  providers: [EmailsService, SendEligibilityService, FilterValidator],
  exports: [EmailsService, SendEligibilityService],
})
export class EmailsModule {}
