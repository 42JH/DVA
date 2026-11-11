import { BillingModule } from './billing/billing.module';
import { Module } from '@nestjs/common';
import { PaymentsModule } from './payments/payments.module';
import { AppController } from './app.controller';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { OrdersModule } from './orders/orders.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    BillingModule,
    AuditModule,
    ApplicationConfigModule,
    DatabaseModule,
    AuthModule,
    OrdersModule,
    PaymentsModule,
    ObservabilityModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
