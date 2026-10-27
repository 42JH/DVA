import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { OrderSubmissionRepository } from './order-submission.repository';
import { DverClient } from './dver.client';
import { OrderAddressesController } from './order-addresses.controller';

@Module({
  imports: [DatabaseModule, AuditModule, CustomersModule],
  controllers: [OrdersController, OrderAddressesController],
  providers: [OrdersRepository, OrdersService, OrderSubmissionRepository, DverClient],
  exports: [OrdersService],
})
export class OrdersModule {}
