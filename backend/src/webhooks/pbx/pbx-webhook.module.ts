import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PbxWebhookController } from './pbx-webhook.controller';
import { PbxWebhookGuard } from './pbx-webhook.guard';
import { PbxWebhookService } from './pbx-webhook.service';
import { PbxWebhookRepository } from './pbx-webhook.repository';
import { PbxRecordingWorker } from './pbx-recording.worker';
import { RecordingStorage } from './recording-storage';
import { ConsultationsModule } from '../../consultations/consultations.module';

@Module({
  imports: [DatabaseModule, ConsultationsModule],
  controllers: [PbxWebhookController],
  providers: [
    PbxWebhookGuard,
    PbxWebhookService,
    PbxWebhookRepository,
    PbxRecordingWorker,
    RecordingStorage,
  ],
  exports: [RecordingStorage],
})
export class PbxWebhookModule {}
