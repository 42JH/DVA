import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RetentionRepository } from './retention.repository';
import { RetentionWorker } from './retention.worker';

@Module({
  imports: [DatabaseModule],
  providers: [RetentionRepository, RetentionWorker],
})
export class RetentionModule {}
