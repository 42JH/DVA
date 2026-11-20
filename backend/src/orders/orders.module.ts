import { Module } from '@nestjs/common';
import { PaymentCardsModule } from '../payments/payment-cards.module';
import { OrderCardPaymentsService } from './order-card-payments.service';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { OrderReadService } from './order-read.service';
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
import { AdminParcelDraftsController } from './admin-parcel-drafts.controller';
import { AdminParcelDraftsService } from './admin-parcel-drafts.service';

@Module({
  imports: [
    PaymentCardsModule,
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
    AdminParcelDraftsController,
  ],
  providers: [
    OrderCardPaymentsService,
    OrdersRepository,
    OrdersService,
    OrderReadService,
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
    AdminParcelDraftsService,
  ],
  exports: [
    OrderPaymentsService,
    OrderCardPaymentsService,
    OrdersRepository,
    ParcelDraftsRepository,
  ],
})
export class OrdersModule {}
