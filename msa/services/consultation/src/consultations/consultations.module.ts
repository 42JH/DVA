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
  controllers: [ConsultationsController, FaqCallSourcesController],
  providers: [
    ConsultationsRepository,
    ConsultationsService,
    CallSessionRepository,
    CallEndRepository,
    ActiveCallCountService,
  ],
  exports: [ConsultationsService, CallEndRepository],
})
export class ConsultationsModule {}
