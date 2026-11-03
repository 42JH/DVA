import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsRepository } from './consultations.repository';
import { ConsultationsService } from './consultations.service';
import { RecordingPlaybackService } from './recording-playback.service';
import { CallSessionRepository } from './call-session.repository';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ActiveCallCountService } from './active-call-count.service';
import { CallEndRepository } from './call-end.repository';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [ConsultationsController],
  providers: [
    ConsultationsRepository,
    ConsultationsService,
    RecordingPlaybackService,
    CallSessionRepository,
    CallEndRepository,
    ActiveCallCountService,
  ],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
