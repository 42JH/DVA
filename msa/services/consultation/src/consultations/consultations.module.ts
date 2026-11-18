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
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    LegacyDraftCallBindingsController,
    ConsultationsController,
    FaqCallSourcesController,
  ],
  providers: [
    CallDraftDeletionClient,
    ConsultationsRepository,
    ConsultationsService,
    CallSessionRepository,
    CallEndRepository,
    ActiveCallCountService,
  ],
  exports: [ConsultationsService, CallEndRepository],
})
export class ConsultationsModule {}
