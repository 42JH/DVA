import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { CallInsightsController } from './call-insights.controller';
import { CallInsightsGuard } from './call-insights.guard';
import { CallInsightsService } from './call-insights.service';
import { CallInsightsRepository } from './call-insights.repository';
import { CallDashboardMetricsController } from './call-dashboard-metrics.controller';
import { CallDashboardMetricsService } from './call-dashboard-metrics.service';
import { CallDashboardMetricsRepository } from './call-dashboard-metrics.repository';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [CallInsightsController, CallDashboardMetricsController],
  providers: [
    CallInsightsGuard,
    CallInsightsService,
    CallInsightsRepository,
    CallDashboardMetricsService,
    CallDashboardMetricsRepository,
  ],
})
export class CallInsightsModule {}
