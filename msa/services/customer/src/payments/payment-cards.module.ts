import { Module } from '@nestjs/common';
import { CardProviderClient } from './card-provider.client';
import { DatabaseModule } from '../database/database.module';
import { CardCallScopes } from './card-call-scopes.service';
import { CardCallScopeController } from './card-call-scope.controller';
import { PaymentCardsController } from './payment-cards.controller';
import { PaymentCardsRepository } from './payment-cards.repository';
import { PaymentCardsService } from './payment-cards.service';
import { PaymentCardRevocationWorker } from './payment-card-revocation.worker';

@Module({
  imports: [DatabaseModule],
  controllers: [CardCallScopeController, PaymentCardsController],
  providers: [
    CardCallScopes,
    CardProviderClient,
    PaymentCardsRepository,
    PaymentCardsService,
    PaymentCardRevocationWorker,
  ],
  exports: [PaymentCardsService],
})
export class PaymentCardsModule {}
