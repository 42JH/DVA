import { UnansweredQuestionsModule } from './unanswered-questions/unanswered-questions.module';
import { RetentionModule } from './retention/retention.module';
import { CustomersModule } from './customers/customers.module';
import { AuditModule } from './audit/audit.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { PbxWebhookModule } from './webhooks/pbx/pbx-webhook.module';
import { CallInsightsModule } from './call-insights/call-insights.module';
import { DashboardModule } from './dashboard/dashboard.module';
@Module({
  imports: [
    ApplicationConfigModule,
    AuditModule,
    CustomersModule,
    DatabaseModule,
    AuthModule,
    ConsultationsModule,
    PbxWebhookModule,
    RetentionModule,
    CallInsightsModule,
    UnansweredQuestionsModule,
    DashboardModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
