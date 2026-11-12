import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PbxWebhookModule } from '../webhooks/pbx/pbx-webhook.module';
import { RetentionRepository } from './retention.repository';
import { RetentionWorker } from './retention.worker';

@Module({
  imports: [DatabaseModule, PbxWebhookModule],
  providers: [RetentionRepository, RetentionWorker],
})
export class RetentionModule {}
