import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsRepository } from './consultations.repository';
import { ConsultationsService } from './consultations.service';
import { RecordingPlaybackService } from './recording-playback.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsRepository, ConsultationsService, RecordingPlaybackService],
})
export class ConsultationsModule {}
