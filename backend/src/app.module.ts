import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DatabaseService } from './database.service';
import { PbxWebhookController } from './pbx-webhook.controller';
import { PbxWebhookGuard } from './pbx-webhook.guard';
import { PbxWebhookService } from './pbx-webhook.service';

@Module({
  controllers: [HealthController, PbxWebhookController],
  providers: [DatabaseService, HealthService, PbxWebhookGuard, PbxWebhookService],
})
export class AppModule {}
