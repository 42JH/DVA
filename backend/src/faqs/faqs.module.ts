import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { FaqsRepository } from './faqs.repository';
import { FaqsService } from './faqs.service';
import { FaqsController } from './faqs.controller';
import { AiFaqsController } from './ai-faqs.controller';
import { AiFaqClient } from './ai-faq.client';
import { FaqNotificationsRepository } from './faq-notifications.repository';
import { FaqNotificationsWorker } from './faq-notifications.worker';

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [
    FaqsRepository,
    FaqsService,
    AiFaqClient,
    FaqNotificationsRepository,
    FaqNotificationsWorker,
  ],
  controllers: [FaqsController, AiFaqsController],
  exports: [FaqsService],
})
export class FaqsModule {}
