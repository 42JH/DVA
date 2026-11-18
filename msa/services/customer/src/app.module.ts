import { PaymentCardsModule } from './payments/payment-cards.module';
import { RetentionModule } from './retention/retention.module';
import { PinsModule } from './pins/pins.module';
import { CallScopeExecutionModule } from './call-scope/call-scope-execution.module';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ApplicationConfigModule } from './config/application-config.module';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './database/database.module';
import { MembersModule } from './members/members.module';
import { OrganizationsModule } from './organizations/organizations.module';

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    AuditModule,
    AuthModule,
    CustomersModule,
    PaymentCardsModule,
    RetentionModule,
    PinsModule,
    CallScopeExecutionModule,
    OrganizationsModule,
    MembersModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
