import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { FaqsRepository } from './faqs.repository';
import { FaqsService } from './faqs.service';
import { FaqsController } from './faqs.controller';
import { AiFaqsController } from './ai-faqs.controller';

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [FaqsRepository, FaqsService],
  controllers: [FaqsController, AiFaqsController],
})
export class FaqsModule {}
