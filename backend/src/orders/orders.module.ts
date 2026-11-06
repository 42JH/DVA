import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { OrderSubmissionRepository } from './order-submission.repository';
import { DverClient } from './dver.client';
import { OrderAddressesController } from './order-addresses.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { OrderPaymentsRepository } from './order-payments.repository';
import { OrderPaymentsService } from './order-payments.service';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OrderMaintenanceWorker } from './order-maintenance.worker';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { OrderSubmissionService } from './order-submission.service';
import { ParcelDraftsController } from './parcel-drafts.controller';
import { ParcelDraftsService } from './parcel-drafts.service';
import { ParcelDraftsRepository } from './parcel-drafts.repository';
import { OrderIntakeController } from './order-intake.controller';
import { OrderIntakeService } from './order-intake.service';
import { OrderIntakeRepository } from './order-intake.repository';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    CustomersModule,
    ConsultationsModule,
    OrganizationsModule,
    DeliveriesModule,
  ],
  controllers: [
    OrdersController,
    OrderAddressesController,
    AdminOrdersController,
    ParcelDraftsController,
    OrderIntakeController,
  ],
  providers: [
    OrdersRepository,
    OrdersService,
    OrderSubmissionRepository,
    OrderSubmissionService,
    DverClient,
    OrderPaymentsRepository,
    OrderPaymentsService,
    OrderMaintenanceWorker,
    ParcelDraftsService,
    ParcelDraftsRepository,
    OrderIntakeService,
    OrderIntakeRepository,
  ],
  exports: [OrderPaymentsService],
})
export class OrdersModule {}
