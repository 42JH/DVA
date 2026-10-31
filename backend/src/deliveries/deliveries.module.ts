import { Module } from '@nestjs/common';
import { DeliveriesRepository } from './deliveries.repository';
import { DeliveriesService } from './deliveries.service';

@Module({
  providers: [DeliveriesRepository, DeliveriesService],
  exports: [DeliveriesService],
})
export class DeliveriesModule {}
