import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CallInsightsModule } from '../call-insights/call-insights.module';
import { DatabaseModule } from '../database/database.module';
import { UnansweredQuestionsController } from './unanswered-questions.controller';
import { UnansweredQuestionsReadController } from './unanswered-questions-read.controller';
import { UnansweredQuestionsRepository } from './unanswered-questions.repository';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@Module({
  imports: [DatabaseModule, AuditModule, CallInsightsModule],
  controllers: [UnansweredQuestionsController, UnansweredQuestionsReadController],
  providers: [UnansweredQuestionsRepository, UnansweredQuestionsService],
})
export class UnansweredQuestionsModule {}
