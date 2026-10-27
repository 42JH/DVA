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

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    HealthModule,
    PbxWebhookModule,
    AuthModule,
    OrganizationsModule,
    OrdersModule,
    CustomersModule,
    MembersModule,
    PinsModule,
  ],
})
export class AppModule {}
