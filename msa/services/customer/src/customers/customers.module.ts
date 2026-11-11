import { OrderReadScopeController } from './order-read-scope.controller';
import { OrganizationBillingService } from '../organizations/organization-billing.service';
import { CallReadReferencesController } from './call-read-references.controller';
import { CallScopeModule } from '../call-scope/call-scope.module';
import { CallContextClient } from './call-context.client';
import { CallerContextQueryController } from './caller-context.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  imports: [DatabaseModule, CallScopeModule],
  controllers: [
    OrderReadScopeController,
    CustomersController,
    CallerContextQueryController,
    CallReadReferencesController,
  ],
  providers: [CustomersService, CustomersRepository, CallContextClient, OrganizationBillingService],
  exports: [CustomersService],
})
export class CustomersModule {}
