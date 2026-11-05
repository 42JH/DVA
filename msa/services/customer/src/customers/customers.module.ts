import { CallContextClient } from './call-context.client';
import { CallerContextQueryController } from './caller-context.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

@Module({
  imports: [DatabaseModule],
  controllers: [CustomersController, CallerContextQueryController],
  providers: [CustomersService, CustomersRepository, CallContextClient],
  exports: [CustomersService],
})
export class CustomersModule {}
