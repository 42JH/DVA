import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DeliveriesRepository } from './deliveries.repository';

@Injectable()
export class DeliveriesService {
  constructor(private readonly repository: DeliveriesRepository) {}

  createForOrder(client: PoolClient, orderId: number) {
    return this.repository.createForOrder(client, orderId);
  }

  lockShipments(client: PoolClient, parcelIds: number[]) {
    return this.repository.lockShipments(client, parcelIds);
  }

  cancelShipments(client: PoolClient, parcelIds: number[], adminId: number | null) {
    return this.repository.cancelShipments(client, parcelIds, adminId);
  }
}
