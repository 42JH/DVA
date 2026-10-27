import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { OrderSubmissionRepository } from './order-submission.repository';
import { DverClient } from './dver.client';

@Module({
  imports: [DatabaseModule, AuditModule, CustomersModule],
  controllers: [OrdersController],
  providers: [OrdersRepository, OrdersService, OrderSubmissionRepository, DverClient],
  exports: [OrdersService],
})
export class OrdersModule {}
