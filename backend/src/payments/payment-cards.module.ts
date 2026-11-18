import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { PaymentCardsRepository } from './payment-cards.repository';
import { PaymentCardsService } from './payment-cards.service';
import { PaymentCardsController } from './payment-cards.controller';
import { CardProviderClient } from './card-provider.client';

@Module({
  imports: [DatabaseModule, AuditModule, ConsultationsModule],
  controllers: [PaymentCardsController],
  providers: [PaymentCardsRepository, PaymentCardsService, CardProviderClient],
  exports: [PaymentCardsService, CardProviderClient],
})
export class PaymentCardsModule {}
