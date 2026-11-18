import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { enqueue } from '@dva/events';
import { DverResult } from './dver.client';
import { OrderStatus } from './orders.types';

type AcceptedResult = Extract<DverResult, { status: 'ACCEPTED' }>;
type Acceptance = {
  orderParcelSeqs: number[];
  attempt: string;
  requestId: string;
  result: AcceptedResult;
};

@Injectable()
export class OrderSubmissionRepository {
  async start(client: PoolClient, id: number, expectedUpdatedAt?: string) {
    const result = await client.query<{ attempt: string; timeoutMs: number }>(
      `UPDATE orders SET status='SUBMITTING',
       submission_first_attempt_at=COALESCE(submission_first_attempt_at,statement_timestamp()),
       submission_last_attempt_at=statement_timestamp() WHERE order_seq=$1
       AND ($2::timestamptz IS NULL OR (updated_at=$2::timestamptz
        AND (submission_first_attempt_at IS NULL OR submission_first_attempt_at>statement_timestamp()-interval '10 minutes')
        AND (submission_last_attempt_at IS NULL OR submission_last_attempt_at<=statement_timestamp()-interval '1 minute')))
       RETURNING submission_last_attempt_at::text AS attempt,
        CASE WHEN submission_first_attempt_at<=statement_timestamp()-interval '10 minutes' THEN 10000
         ELSE GREATEST(1,LEAST(10000,extract(epoch FROM
          (submission_first_attempt_at+interval '10 minutes'-statement_timestamp()))*1000))::int END AS "timeoutMs"`,
      [id, expectedUpdatedAt ?? null],
    );
    return result.rows[0];
  }

  async recoveryCandidates(client: PoolClient): Promise<number[]> {
    const result = await client.query<{ id: number }>(
      `SELECT order_seq AS id FROM orders WHERE deleted_at IS NULL
       AND COALESCE(closed_at,created_at)>statement_timestamp()-interval '5 years'
       AND ((status='SUBMITTING' AND COALESCE(submission_last_attempt_at,updated_at)<=statement_timestamp()-interval '10 seconds')
        OR (status IN ('PAID','SUBMITTING_FAILED') AND submission_first_attempt_at<=statement_timestamp()-interval '10 minutes'))
       AND NOT EXISTS (SELECT 1 FROM outbox_events WHERE aggregate_seq=orders.order_seq
        AND destination='delivery' AND event_type='OrderSubmissionDeliveryRequested' AND delivered_at IS NULL)
       ORDER BY submission_last_attempt_at NULLS FIRST,order_seq LIMIT 100 FOR UPDATE SKIP LOCKED`,
    );
    return result.rows.map((row) => row.id);
  }

  async markStale(client: PoolClient, id: number): Promise<OrderStatus | undefined> {
    const result = await client.query<{ status: OrderStatus }>(
      `UPDATE orders SET status=CASE
        WHEN COALESCE(submission_first_attempt_at,updated_at)<=statement_timestamp()-interval '10 minutes'
         THEN 'SUBMISSION_FAILED' ELSE 'SUBMITTING_FAILED' END,
       submission_first_attempt_at=COALESCE(submission_first_attempt_at,updated_at),
       submission_last_attempt_at=COALESCE(submission_last_attempt_at,updated_at)
       WHERE order_seq=$1 AND deleted_at IS NULL
        AND ((status='SUBMITTING' AND COALESCE(submission_last_attempt_at,updated_at)<=statement_timestamp()-interval '10 seconds')
         OR (status IN ('PAID','SUBMITTING_FAILED') AND submission_first_attempt_at<=statement_timestamp()-interval '10 minutes'))
       AND NOT EXISTS (SELECT 1 FROM outbox_events WHERE aggregate_seq=$1
        AND destination='delivery' AND event_type='OrderSubmissionDeliveryRequested' AND delivered_at IS NULL)
       RETURNING status`,
      [id],
    );
    return result.rows[0]?.status;
  }

  async queueAcceptance(
    client: PoolClient,
    id: number,
    requestId: string,
    result: AcceptedResult,
    attempt: string,
  ): Promise<string | undefined> {
    const current = await client.query(
      `SELECT 1 FROM orders WHERE order_seq=$1 AND status='SUBMITTING'
       AND submission_last_attempt_at=$2::timestamptz FOR UPDATE`,
      [id, attempt],
    );
    if (!current.rowCount) return;
    const parcels = await client.query<{ orderParcelSeq: number }>(
      `SELECT order_parcel_seq AS "orderParcelSeq" FROM order_parcels
       WHERE order_seq=$1 AND status='ACTIVE' ORDER BY order_parcel_seq`,
      [id],
    );
    return enqueue(client, {
      destination: 'delivery',
      eventType: 'OrderSubmissionDeliveryRequested',
      aggregateSeq: id,
      payload: {
        requestId,
        result,
        attempt,
        orderParcelSeqs: parcels.rows.map((row) => row.orderParcelSeq),
      },
    });
  }

  async acceptance(client: PoolClient, id: number, eventId: string) {
    const result = await client.query<{ payload: Acceptance }>(
      `SELECT payload FROM outbox_events WHERE event_id=$1 AND aggregate_seq=$2
       AND destination='delivery' AND event_type='OrderSubmissionDeliveryRequested'
       AND delivered_at IS NULL FOR UPDATE`,
      [eventId, id],
    );
    return result.rows[0]?.payload;
  }

  async finish(
    client: PoolClient,
    id: number,
    result: DverResult,
    attempt: string,
  ): Promise<OrderStatus | undefined> {
    const saved = await client.query<{ status: OrderStatus }>(
      `UPDATE orders SET status=CASE WHEN $2='ACCEPTED' THEN 'ACCEPTED'
        WHEN submission_first_attempt_at<=statement_timestamp()-interval '10 minutes' THEN 'SUBMISSION_FAILED'
        ELSE 'SUBMITTING_FAILED' END,parcel_no=$3,dver_received_at=$4
       WHERE order_seq=$1 AND status='SUBMITTING' AND submission_last_attempt_at=$5::timestamptz
       RETURNING status`,
      [
        id,
        result.status,
        result.status === 'ACCEPTED' ? result.parcelNo : null,
        result.status === 'ACCEPTED' ? result.receivedAt : null,
        attempt,
      ],
    );
    if (saved.rowCount !== 1) return;
    return saved.rows[0].status;
  }
}
