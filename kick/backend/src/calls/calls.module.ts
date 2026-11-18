import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { DatabaseModule } from '../database/database.module';
import { CallPushService } from './call-push.service';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { LiveKitService } from './livekit.service';

@Module({
  imports: [DatabaseModule, AccountsModule],
  controllers: [CallsController],
  providers: [CallsService, LiveKitService, CallPushService],
})
export class CallsModule {}
