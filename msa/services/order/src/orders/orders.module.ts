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
    AdminOrdersController,
    OrderAddressesController,
    OrderReadController,
  ],
  providers: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
