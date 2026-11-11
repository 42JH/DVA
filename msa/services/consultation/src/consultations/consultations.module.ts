import { LegacyDraftCallBindingsController } from './legacy-draft-call-bindings.controller';
import { CallDraftDeletionClient } from './call-draft-deletion.client';
import { FaqCallSourcesController } from './faq-call-sources.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsRepository } from './consultations.repository';
import { ConsultationsService } from './consultations.service';
import { CallSessionRepository } from './call-session.repository';
import { CallEndRepository } from './call-end.repository';
import { ActiveCallCountService } from './active-call-count.service';
import { RecordingPlaybackService } from './recording-playback.service';
import { CallReadReferencesClient } from './call-read-references.client';
import { OrderIntakeController } from './order-intake.controller';
import { OrderIntakeService } from './order-intake.service';
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    LegacyDraftCallBindingsController,
    ConsultationsController,
    FaqCallSourcesController,
    OrderIntakeController,
  ],
  providers: [
    CallDraftDeletionClient,
    ConsultationsRepository,
    ConsultationsService,
    CallSessionRepository,
    CallEndRepository,
    ActiveCallCountService,
    RecordingPlaybackService,
    CallReadReferencesClient,
    OrderIntakeService,
  ],
  exports: [
    ConsultationsService,
    ConsultationsRepository,
    CallEndRepository,
    CallReadReferencesClient,
  ],
})
export class ConsultationsModule {}
