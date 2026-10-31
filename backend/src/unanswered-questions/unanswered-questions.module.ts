import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CallInsightsModule } from '../call-insights/call-insights.module';
import { DatabaseModule } from '../database/database.module';
import { FaqsModule } from '../faqs/faqs.module';
import { UnansweredQuestionsController } from './unanswered-questions.controller';
import { UnansweredQuestionsReadController } from './unanswered-questions-read.controller';
import { UnansweredQuestionsManagementController } from './unanswered-questions-management.controller';
import { UnansweredQuestionsRepository } from './unanswered-questions.repository';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@Module({
  imports: [DatabaseModule, AuditModule, CallInsightsModule, FaqsModule],
  controllers: [
    UnansweredQuestionsController,
    UnansweredQuestionsReadController,
    UnansweredQuestionsManagementController,
  ],
  providers: [UnansweredQuestionsRepository, UnansweredQuestionsService],
})
export class UnansweredQuestionsModule {}
