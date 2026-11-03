import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { DverResult } from './dver.client';
import { DeliveriesService } from '../deliveries/deliveries.service';

@Injectable()
export class OrderSubmissionRepository {
  constructor(private readonly deliveries: DeliveriesService) {}
  async hasShipments(client: PoolClient, id: number): Promise<boolean> {
    return (
      await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM shipments s JOIN order_parcels p USING(order_parcel_seq)
         WHERE p.order_seq=$1) AS exists`,
        [id],
      )
    ).rows[0].exists;
  }

  async isCompanyCustomer(client: PoolClient, customerId: number): Promise<boolean> {
    const result = await client.query(
      `SELECT m.membership_seq FROM memberships m JOIN organizations o USING(organization_seq)
         WHERE m.customer_seq=$1 AND m.status='ACTIVE' AND o.status='ACTIVE' AND m.deleted_at IS NULL AND o.deleted_at IS NULL
         FOR SHARE OF m,o`,
      [customerId],
    );
    return result.rowCount === 1;
  }

  async start(client: PoolClient, id: number, expectedUpdatedAt?: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE orders SET status='SUBMITTING' WHERE order_seq=$1
       AND ($2::timestamptz IS NULL OR updated_at=$2::timestamptz)`,
      [id, expectedUpdatedAt ?? null],
    );
    return result.rowCount === 1;
  }

  async markStale(client: PoolClient, id: number): Promise<boolean> {
    // shortcut: 중단된 접수는 재호출 때 확인 필요로 전환한다. 상시 감시가 필요해지면 별도 작업으로 이동한다.
    const result = await client.query(
      `UPDATE orders SET status='SUBMISSION_FAILED' WHERE order_seq=$1 AND status='SUBMITTING'
       AND updated_at < clock_timestamp()-interval '1 minute'`,
      [id],
    );
    return result.rowCount === 1;
  }

  async finish(client: PoolClient, id: number, result: DverResult): Promise<void> {
    const saved = await client.query(
      `UPDATE orders SET status=$2,parcel_no=$3,dver_received_at=$4
       WHERE order_seq=$1 AND status IN ('SUBMITTING','SUBMISSION_FAILED')`,
      [
        id,
        result.status,
        result.status === 'ACCEPTED' ? result.parcelNo : null,
        result.status === 'ACCEPTED' ? result.receivedAt : null,
      ],
    );
    if (saved.rowCount !== 1)
      throw new ApiException(409, 'INVALID_STATE', '접수 결과를 저장할 수 없는 주문 상태입니다.');
    if (result.status === 'ACCEPTED') {
      await this.deliveries.createForOrder(client, id);
    }
  }
}
