import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PbxWebhookController } from './pbx-webhook.controller';
import { PbxWebhookGuard } from './pbx-webhook.guard';
import { PbxWebhookService } from './pbx-webhook.service';
import { PbxWebhookRepository } from './pbx-webhook.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [PbxWebhookController],
  providers: [PbxWebhookGuard, PbxWebhookService, PbxWebhookRepository],
})
export class PbxWebhookModule {}
