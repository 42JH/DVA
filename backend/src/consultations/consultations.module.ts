import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsRepository } from './consultations.repository';
import { ConsultationsService } from './consultations.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsRepository, ConsultationsService],
})
export class ConsultationsModule {}
