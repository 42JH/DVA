import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { DashboardPersonaClient } from './dashboard-persona.client';

@Module({
  imports: [DatabaseModule],
  controllers: [DashboardController],
  providers: [DashboardRepository, DashboardService, DashboardPersonaClient],
})
export class DashboardModule {}
