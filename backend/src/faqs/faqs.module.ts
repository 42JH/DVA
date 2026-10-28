import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { FaqsRepository } from './faqs.repository';
import { FaqsService } from './faqs.service';
import { FaqsController } from './faqs.controller';

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [FaqsRepository, FaqsService],
  controllers: [FaqsController],
})
export class FaqsModule {}
