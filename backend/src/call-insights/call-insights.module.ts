import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { CallInsightsController } from './call-insights.controller';
import { CallInsightsGuard } from './call-insights.guard';
import { CallInsightsRepository } from './call-insights.repository';
import { CallInsightsService } from './call-insights.service';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [CallInsightsController],
  providers: [CallInsightsGuard, CallInsightsRepository, CallInsightsService],
})
export class CallInsightsModule {}
