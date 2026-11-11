import { OrderIntakeWritesService } from './order-intake-writes.service';
import { PaymentsRepository } from '../payments/payments.repository';
import { AdminParcelDraftsController } from './admin-parcel-drafts.controller';
import { AdminParcelDraftsService } from './admin-parcel-drafts.service';
import { ParcelDraftsController } from './parcel-draft-reads.controller';
import { ParcelDraftReadsService } from './parcel-draft-reads.service';
import { ParcelDraftReadsRepository } from './parcel-draft-reads.repository';
import { ParcelDraftRetentionWorker } from './parcel-draft-retention.worker';
import { CallReadReferencesController } from './call-read-references.controller';
import { CallEventOrderScopeController } from './call-event-order-scope.controller';
import { ParcelDraftMigrationService } from './parcel-draft-migration.service';
import { CallDraftDeletionController } from './call-draft-deletion.controller';
import { OrderDeletionCheckClient } from './order-deletion-check.client';
import { OrderCancellationController } from './order-cancellation.controller';
import { OrderShipmentCheckClient } from './order-shipment-check.client';
import { ParcelDraftWriteController } from './parcel-draft-write.controller';
import { ParcelDraftWritesService } from './parcel-draft-writes.service';
import { ParcelDraftWritesRepository } from './parcel-draft-writes.repository';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import { ParcelDraftWriteWorker } from './parcel-draft-write.worker';
import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { HomeOrdersController } from './home-orders.controller';
import { DatabaseModule } from '../database/database.module';
import { OrdersService } from './orders.service';
import { OrdersRepository } from './orders.repository';
import { OrdersController } from './orders.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { OrderAddressesController } from './order-addresses.controller';
import { OrderReadController } from './order-read.controller';
import { DverClient } from './dver.client';
import { OrderSubmissionRepository } from './order-submission.repository';
import { OrderSubmissionService } from './order-submission.service';
import { OrderSubmissionWorker } from './order-submission.worker';

@Module({
  imports: [DatabaseModule, BillingModule],
  controllers: [
    HomeOrdersController,
    ParcelDraftWriteController,
    AdminParcelDraftsController,
    ParcelDraftsController,
    CallReadReferencesController,
    CallEventOrderScopeController,
    OrdersController,
    CallDraftDeletionController,
    OrderCancellationController,
    AdminOrdersController,
    OrderAddressesController,
    OrderReadController,
  ],
  providers: [
    OrderIntakeWritesService,
    PaymentsRepository,
    ParcelDraftWritesService,
    ParcelDraftWritesRepository,
    ParcelDraftWriteScope,
    ParcelDraftWriteWorker,
    AdminParcelDraftsService,
    ParcelDraftReadsService,
    ParcelDraftReadsRepository,
    ParcelDraftMigrationService,
    ParcelDraftRetentionWorker,
    OrderShipmentCheckClient,
    OrderDeletionCheckClient,
    OrdersService,
    OrdersRepository,
    DverClient,
    OrderSubmissionRepository,
    OrderSubmissionService,
    OrderSubmissionWorker,
  ],
  exports: [OrderSubmissionService, OrdersRepository],
})
export class OrdersModule {}
