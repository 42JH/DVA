import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enqueue } from '@dva/events';
import { requestRetainedOrders } from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';

const ACTIVE_PAYMENT_WORK = `COALESCE((r.approval_claimed_until>clock_timestamp()
 OR (r.notification_status='SENDING' AND r.notification_attempted_at>clock_timestamp()-interval '45 seconds')
 OR (r.completion_notification_status='SENDING' AND r.completion_notification_attempted_at>clock_timestamp()-interval '45 seconds')),false)`;

@Injectable()
export class OrderRetentionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async purgeDatabase(): Promise<boolean> {
    return this.database.transaction(async (client) => {
      for (const [key, value] of [
        [20261103, 157],
        [20261027, 37],
      ])
        if (
          !(
            await client.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_xact_lock($1,$2) AS locked',
              [key, value],
            )
          ).rows[0].locked
        )
          return false;
      await client.query("SET LOCAL lock_timeout='1s'");
      await client.query(`DELETE FROM order_parcel_drafts WHERE draft_seq IN (
        SELECT draft_seq FROM order_parcel_drafts WHERE retention_started_at<=statement_timestamp()-interval '5 years'
        ORDER BY retention_started_at,draft_seq LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const cutoff = (
        await client.query<{ cutoff: string }>(
          "SELECT (statement_timestamp()-interval '5 years')::text AS cutoff",
        )
      ).rows[0].cutoff;
      let after: { id: number; at: string } | undefined;
      let selected = 0;
      while (selected < 10) {
        const candidates = await client.query<{ id: number; at: string }>(
          `SELECT o.order_seq AS id,COALESCE(o.closed_at,o.created_at)::text AS at FROM orders o
           WHERE COALESCE(o.closed_at,o.created_at)<=$1::timestamptz
            AND ($2::timestamptz IS NULL OR (COALESCE(o.closed_at,o.created_at),o.order_seq)>($2::timestamptz,$3::int))
            AND NOT(o.status='SUBMITTING' AND COALESCE(o.submission_last_attempt_at,o.updated_at)>clock_timestamp()-interval '10 seconds')
            AND NOT EXISTS(SELECT 1 FROM order_payment_requests r WHERE r.order_seq=o.order_seq AND ${ACTIVE_PAYMENT_WORK})
           ORDER BY COALESCE(o.closed_at,o.created_at),o.order_seq LIMIT 1000 FOR UPDATE OF o SKIP LOCKED`,
          [cutoff, after?.at ?? null, after?.id ?? 0],
        );
        if (!candidates.rows.length) break;
        const retained = new Set(
          await requestRetainedOrders(
            this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/order-deletion-check',
            this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
            candidates.rows.map((row) => row.id),
          ),
        );
        const eligible = candidates.rows
          .filter((order) => !retained.has(order.id))
          .slice(0, 10 - selected);
        selected += eligible.length;
        for (const order of eligible) {
          const requests = await client.query<{ busy: boolean }>(
            `SELECT ${ACTIVE_PAYMENT_WORK} AS busy FROM order_payment_requests r
             WHERE r.order_seq=$1 ORDER BY r.payment_request_id FOR UPDATE`,
            [order.id],
          );
          if (requests.rows.some((row) => row.busy)) continue;
          await client.query("SELECT set_config('dva.retention_order',$1,true)", [
            String(order.id),
          ]);
          const parcels = await client.query<{ id: number }>(
            'SELECT order_parcel_seq AS id FROM order_parcels WHERE order_seq=$1 ORDER BY order_parcel_seq',
            [order.id],
          );
          for (let index = 0; index < parcels.rows.length; index += 1000)
            await enqueue(client, {
              destination: 'delivery',
              eventType: 'OrderParcelsPurged',
              aggregateSeq: order.id,
              payload: {
                orderParcelSeqs: parcels.rows.slice(index, index + 1000).map((row) => row.id),
              },
            });
          await client.query(
            "DELETE FROM outbox_events WHERE aggregate_seq=$1 AND destination='delivery' AND event_type='OrderSubmissionDeliveryRequested'",
            [order.id],
          );
          await client.query('DELETE FROM order_parcels WHERE order_seq=$1', [order.id]);
          await client.query('DELETE FROM order_payment_requests WHERE order_seq=$1', [order.id]);
          await client.query('DELETE FROM order_billing_charges WHERE order_seq=$1', [order.id]);
          await client.query('DELETE FROM orders WHERE order_seq=$1', [order.id]);
        }
        after = candidates.rows[candidates.rows.length - 1];
        if (candidates.rows.length < 1000) break;
      }
      await client.query(`DELETE FROM organization_billing_months b WHERE (b.organization_seq,b.billing_month) IN (
        SELECT organization_seq,billing_month FROM organization_billing_months m
        WHERE m.billing_month+interval '5 years 1 month'<=statement_timestamp()
         AND NOT EXISTS(SELECT 1 FROM order_billing_charges c WHERE c.organization_seq=m.organization_seq AND c.billing_month=m.billing_month)
        LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      return true;
    });
  }
}
