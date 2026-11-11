import { ParcelDraftWriteController } from './parcel-draft-write.controller';
import { OrderReferenceScopes } from './order-reference-scopes.service';
import { OrderDeletionCheckController } from './order-deletion-check.controller';
import { OrderReadScopeController } from './order-read-scope.controller';
import { CallScopeController } from './call-scope.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { CallerContextCommandController } from './caller-context.controller';
import { CustomersService } from './customers.service';
import { CustomerContextClient } from './customer-context.client';

@Module({
  imports: [DatabaseModule, ConsultationsModule],
  controllers: [
    ParcelDraftWriteController,
    OrderReadScopeController,
    OrderDeletionCheckController,
    CallerContextCommandController,
    CallScopeController,
  ],
  providers: [OrderReferenceScopes, CustomersService, CustomerContextClient],
  exports: [CustomerContextClient, OrderReferenceScopes],
})
export class CustomersModule {}
