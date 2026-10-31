import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { CallInsightsController } from './call-insights.controller';
import { CallInsightsGuard } from './call-insights.guard';
import { CallInsightsRepository } from './call-insights.repository';
import { CallInsightsService } from './call-insights.service';
import { CallEventsController } from './call-events.controller';
import { CallEventsReadController } from './call-events-read.controller';
import { CallEventsRepository } from './call-events.repository';
import { CallEventsService } from './call-events.service';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [CallInsightsController, CallEventsController, CallEventsReadController],
  providers: [
    CallInsightsGuard,
    CallInsightsRepository,
    CallInsightsService,
    CallEventsRepository,
    CallEventsService,
  ],
  exports: [CallInsightsGuard],
})
export class CallInsightsModule {}
