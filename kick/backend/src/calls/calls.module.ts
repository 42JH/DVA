import { Module } from '@nestjs/common';

import { TestAccountGuard } from '../accounts/test-account.guard';
import { DatabaseModule } from '../database/database.module';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

@Module({
  imports: [DatabaseModule],
  controllers: [CallsController],
  providers: [CallsService, TestAccountGuard],
})
export class CallsModule {}
