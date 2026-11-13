import { Module } from '@nestjs/common';

import { AccountsModule } from './accounts/accounts.module';
import { CallsModule } from './calls/calls.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [DatabaseModule, AccountsModule, CallsModule, VoiceModule],
  controllers: [HealthController],
})
export class AppModule {}
