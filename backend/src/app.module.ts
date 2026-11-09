import { AuthModule } from './auth/auth.module';
import { Module } from '@nestjs/common';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PbxWebhookModule } from './webhooks/pbx/pbx-webhook.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { OrdersModule } from './orders/orders.module';
import { CustomersModule } from './customers/customers.module';
import { MembersModule } from './members/members.module';
import { PinsModule } from './pins/pins.module';
import { ConsultationsModule } from './consultations/consultations.module';
import { AiSettingsModule } from './ai-settings/ai-settings.module';
import { FaqsModule } from './faqs/faqs.module';
import { ObservabilityModule } from './observability/observability.module';
import { PaymentsModule } from './payments/payments.module';
import { CallInsightsModule } from './call-insights/call-insights.module';
import { UnansweredQuestionsModule } from './unanswered-questions/unanswered-questions.module';
import { RetentionModule } from './retention/retention.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    HealthModule,
    ObservabilityModule,
    PbxWebhookModule,
    AuthModule,
    OrganizationsModule,
    OrdersModule,
    PaymentsModule,
    CustomersModule,
    MembersModule,
    PinsModule,
    ConsultationsModule,
    CallInsightsModule,
    UnansweredQuestionsModule,
    AiSettingsModule,
    FaqsModule,
    RetentionModule,
    DashboardModule,
  ],
})
export class AppModule {}
