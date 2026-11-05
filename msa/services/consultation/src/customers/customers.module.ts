import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ConsultationsModule } from '../consultations/consultations.module';
import { CallerContextCommandController } from './caller-context.controller';
import { CustomersService } from './customers.service';
import { CustomerContextClient } from './customer-context.client';

@Module({
  imports: [DatabaseModule, ConsultationsModule],
  controllers: [CallerContextCommandController],
  providers: [CustomersService, CustomerContextClient],
  exports: [CustomerContextClient],
})
export class CustomersModule {}
