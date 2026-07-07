import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportJob } from './entities/import-job.entity';
import { SyncState } from './entities/sync-state.entity';
import { Email } from '../emails/entities/email.entity';
import { EmailSource } from '../emails/entities/email-source.entity';
import { Domain } from '../domains/entities/domain.entity';
import { JsonImportService } from './services/json-import.service';
import { CsvImportService } from './services/csv-import.service';
import { WooCommerceImportService } from './services/woocommerce-import.service';
import { InventoryPalImportService } from './services/inventorypal-import.service';
import { ImportController } from './controllers/import.controller';
import { EmailsModule } from '../emails/emails.module';
import { DomainsModule } from '../domains/domains.module';
import { CustomersModule } from '../customers/customers.module';
import { EmailVerificationModule } from '../email-verification/email-verification.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ImportJob, SyncState, Email, EmailSource, Domain]),
    EmailsModule,
    EmailVerificationModule,
    DomainsModule,
    CustomersModule,
  ],
  controllers: [ImportController],
  providers: [JsonImportService, CsvImportService, WooCommerceImportService, InventoryPalImportService],
  exports: [JsonImportService, CsvImportService, WooCommerceImportService, InventoryPalImportService],
})
export class ImportModule {}
