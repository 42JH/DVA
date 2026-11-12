import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';
import { PaymentsWorker } from './payments.worker';
import { CardPaymentScopeController } from './card-payment-scope.controller';
@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController, CardPaymentScopeController],
  providers: [PaymentsWorker],
})
export class PaymentsModule {}
