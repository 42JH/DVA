import { Module } from '@nestjs/common';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PbxWebhookModule } from './webhooks/pbx/pbx-webhook.module';

@Module({
  imports: [ApplicationConfigModule, DatabaseModule, HealthModule, PbxWebhookModule],
})
export class AppModule {}
