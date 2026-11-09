import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { PinsModule } from '../pins/pins.module';
import { CallScopeModule } from './call-scope.module';
import { CallScopeExecutionController } from './call-scope-execution.controller';

@Module({
  imports: [CustomersModule, PinsModule, CallScopeModule],
  controllers: [CallScopeExecutionController],
})
export class CallScopeExecutionModule {}
