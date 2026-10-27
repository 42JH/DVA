import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { IncompleteConsultationsController } from './incomplete-consultations.controller';
import { IncompleteConsultationsService } from './incomplete-consultations.service';
import { IncompleteConsultationsRepository } from './incomplete-consultations.repository';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [IncompleteConsultationsController],
  providers: [IncompleteConsultationsService, IncompleteConsultationsRepository],
})
export class ConsultationsModule {}
