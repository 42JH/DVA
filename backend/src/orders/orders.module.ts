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

@Module({
  imports: [DatabaseModule, AuditModule, CustomersModule, ConsultationsModule],
  controllers: [OrdersController, OrderAddressesController, AdminOrdersController],
  providers: [
    OrdersRepository,
    OrdersService,
    OrderSubmissionRepository,
    DverClient,
    OrderPaymentsRepository,
    OrderPaymentsService,
  ],
  exports: [OrdersService, OrderPaymentsService],
})
export class OrdersModule {}
