import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { HomeService } from './home.service';
import { OrdersModule } from '../orders/orders.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { UnansweredQuestionsModule } from '../unanswered-questions/unanswered-questions.module';

@Module({
  imports: [DatabaseModule, OrdersModule, ConsultationsModule, UnansweredQuestionsModule],
  controllers: [DashboardController],
  providers: [DashboardRepository, DashboardService, HomeService],
})
export class DashboardModule {}
