import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsRepository } from './consultations.repository';
import { ConsultationsService } from './consultations.service';
import { RecordingsController } from './recordings.controller';
import { RecordingPlaybackService } from './recording-playback.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ConsultationsController, RecordingsController],
  providers: [ConsultationsRepository, ConsultationsService, RecordingPlaybackService],
})
export class ConsultationsModule {}
