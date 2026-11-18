import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingWorker } from './billing.worker';

@Module({
  imports: [DatabaseModule],
  controllers: [BillingController],
  providers: [BillingService, BillingWorker],
})
export class BillingModule {}
