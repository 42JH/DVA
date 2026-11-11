import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { DatabaseModule } from '../database/database.module';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PaymentClient } from './payment.client';
import { PaymentsWorker } from './payments.worker';
@Module({
  imports: [DatabaseModule, OrdersModule],
  controllers: [PaymentsController],
  providers: [PaymentsRepository, PaymentsService, PaymentClient, PaymentsWorker],
})
export class PaymentsModule {}
