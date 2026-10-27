import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { DverResult } from './dver.client';

@Injectable()
export class OrderSubmissionRepository {
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
    try {
      const result = await client.query(
        `SELECT m.membership_seq FROM memberships m JOIN organizations o USING(organization_seq)
         WHERE m.customer_seq=$1 AND m.status='ACTIVE' AND o.status='ACTIVE'
         FOR SHARE OF m,o NOWAIT`,
        [customerId],
      );
      return result.rowCount === 1;
    } catch (error) {
      // 구성원 변경은 기업→고객 순으로 잠그므로 여기서는 기다려 교착시키지 않는다.
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03')
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '고객 소속을 변경 중입니다. 잠시 후 재시도해 주세요.',
        );
      throw error;
    }
  }

  async start(client: PoolClient, id: number) {
    await client.query("UPDATE orders SET status='SUBMITTING' WHERE order_seq=$1", [id]);
  }

  async markStale(client: PoolClient, id: number): Promise<boolean> {
    // shortcut: 중단된 접수는 재호출 때 확인 필요로 전환한다. 상시 감시가 필요해지면 별도 작업으로 이동한다.
    const result = await client.query(
      `UPDATE orders SET status='REVIEW_REQUIRED' WHERE order_seq=$1 AND status='SUBMITTING'
       AND updated_at < clock_timestamp()-interval '1 minute'`,
      [id],
    );
    return result.rowCount === 1;
  }

  async finish(client: PoolClient, id: number, result: DverResult): Promise<void> {
    const saved = await client.query(
      `UPDATE orders SET status=$2,parcel_no=$3,dver_received_at=$4
       WHERE order_seq=$1 AND status IN ('SUBMITTING','REVIEW_REQUIRED')`,
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
      await client.query(
        `WITH created AS (
           INSERT INTO shipments(order_parcel_seq,tracking_number)
           SELECT order_parcel_seq,'DVA-'||gen_random_uuid()::text FROM order_parcels
           WHERE order_seq=$1 RETURNING shipment_seq
         ) INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type)
           SELECT shipment_seq,gen_random_uuid(),'notPaid','SYSTEM' FROM created`,
        [id],
      );
    }
  }
}
