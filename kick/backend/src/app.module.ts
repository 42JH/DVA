import { Module } from '@nestjs/common';

import { CallsModule } from './calls/calls.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [DatabaseModule, CallsModule],
  controllers: [HealthController],
})
export class AppModule {}
