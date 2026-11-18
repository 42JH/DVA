import { Module } from '@nestjs/common';
import { ConsultationsModule } from '../consultations/consultations.module';
import { UnansweredQuestionsModule } from '../unanswered-questions/unanswered-questions.module';
import { CustomersModule } from '../customers/customers.module';
import { HomeService } from './home.service';
import { DatabaseModule } from '../database/database.module';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { DashboardPersonaClient } from './dashboard-persona.client';

@Module({
  imports: [
    DatabaseModule,
    ConsultationsModule,
    UnansweredQuestionsModule,
    CustomersModule,
  ],
  controllers: [DashboardController],
  providers: [
    DashboardRepository,
    DashboardService,
    DashboardPersonaClient,
    HomeService,
  ],
})
export class DashboardModule {}
