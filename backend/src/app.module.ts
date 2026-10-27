import { AuthModule } from './auth/auth.module';
import { Module } from '@nestjs/common';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { PbxWebhookModule } from './webhooks/pbx/pbx-webhook.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { OrdersModule } from './orders/orders.module';
import { ConsultationsModule } from './consultations/consultations.module';

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    HealthModule,
    PbxWebhookModule,
    AuthModule,
    OrganizationsModule,
    OrdersModule,
    ConsultationsModule,
  ],
})
export class AppModule {}
