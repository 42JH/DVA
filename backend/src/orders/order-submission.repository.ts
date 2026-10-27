import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { DverResult } from './dver.client';

@Injectable()
export class OrderSubmissionRepository {
  async lockRequest(client: PoolClient, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`orders.submit:${key}`).digest();
    return (
      await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired',
        [hash.readInt32BE(0), hash.readInt32BE(4)],
      )
    ).rows[0].acquired;
  }

  async findRequest(client: PoolClient, key: string) {
    return (
      await client.query<{ orderSeq: number; expectedVersion: number }>(
        `SELECT order_seq AS "orderSeq",submission_expected_version AS "expectedVersion"
       FROM orders WHERE submission_request_id=$1::uuid`,
        [key],
      )
    ).rows[0];
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

  async start(client: PoolClient, id: number, key: string, version: number) {
    await client.query(
      `UPDATE orders SET status='SUBMITTING',submission_request_id=$2::uuid,
         submission_expected_version=$3,submission_started_at=clock_timestamp()
       WHERE order_seq=$1`,
      [id, key, version],
    );
  }

  async markStale(client: PoolClient, id: number): Promise<boolean> {
    // shortcut: 중단된 접수는 같은 키의 재조회 때 복구한다. 상시 감시가 필요해지면 별도 작업으로 이동한다.
    const result = await client.query(
      `UPDATE orders SET status='REVIEW_REQUIRED' WHERE order_seq=$1 AND status='SUBMITTING'
       AND submission_started_at < clock_timestamp()-interval '1 minute'`,
      [id],
    );
    return result.rowCount === 1;
  }

  async finish(client: PoolClient, id: number, key: string, result: DverResult): Promise<void> {
    const saved = await client.query(
      `UPDATE orders SET status=$3,parcel_no=$4,dver_received_at=$5
       WHERE order_seq=$1 AND submission_request_id=$2::uuid AND status IN ('SUBMITTING','REVIEW_REQUIRED')`,
      [
        id,
        key,
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
