import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CallInsightsModule } from '../call-insights/call-insights.module';
import { DatabaseModule } from '../database/database.module';
import { UnansweredQuestionsController } from './unanswered-questions.controller';
import { UnansweredQuestionsManagementController } from './unanswered-questions-management.controller';
import { UnansweredQuestionsRepository } from './unanswered-questions.repository';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@Module({
  imports: [AuditModule, CallInsightsModule, DatabaseModule],
  controllers: [
    UnansweredQuestionsController,
    UnansweredQuestionsManagementController,
  ],
  providers: [UnansweredQuestionsRepository, UnansweredQuestionsService],
})
export class UnansweredQuestionsModule {}
