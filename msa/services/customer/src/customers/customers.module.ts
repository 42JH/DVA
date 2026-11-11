import { ParcelDraftWriteController } from './parcel-draft-write.controller';
import { OrderReferenceScopes } from './order-reference-scopes.service';
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
    ParcelDraftWriteController,
    OrderReadScopeController,
    CustomersController,
    CallerContextQueryController,
    CallReadReferencesController,
  ],
  providers: [
    OrderReferenceScopes,
    CustomersService,
    CustomersRepository,
    CallContextClient,
    OrganizationBillingService,
  ],
  exports: [CustomersService],
})
export class CustomersModule {}
