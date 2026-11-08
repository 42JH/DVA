import { ParcelDraftRetentionWorker } from './parcel-draft-retention.worker';
import { ParcelDraftMigrationService } from './parcel-draft-migration.service';
import { CallDraftDeletionController } from './call-draft-deletion.controller';
import { OrderDeletionCheckClient } from './order-deletion-check.client';
import { OrderCancellationController } from './order-cancellation.controller';
import { OrderShipmentCheckClient } from './order-shipment-check.client';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrdersService } from './orders.service';
import { OrdersRepository } from './orders.repository';
import { OrdersController } from './orders.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { OrderAddressesController } from './order-addresses.controller';
import { OrderReadController } from './order-read.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [
    OrdersController,
    CallDraftDeletionController,
    OrderCancellationController,
    AdminOrdersController,
    OrderAddressesController,
    OrderReadController,
  ],
  providers: [
    ParcelDraftMigrationService,
    ParcelDraftRetentionWorker,
    OrderShipmentCheckClient,
    OrderDeletionCheckClient,
    OrdersService,
    OrdersRepository,
  ],
})
export class OrdersModule {}
