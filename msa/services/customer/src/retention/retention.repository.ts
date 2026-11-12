import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { enqueue } from '@dva/events';
import { requestRetainedCustomers } from '@dva/events/call-read-references.cjs';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class RetentionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async purgeDatabase(): Promise<boolean> {
    return this.database.transaction(async (client) => {
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261103,157) AS locked',
          )
        ).rows[0].locked
      )
        return false;
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261027,37) AS locked',
          )
        ).rows[0].locked
      )
        return false;
      await client.query("SET LOCAL lock_timeout='1s'");
      const cards = await client.query<{ payment_card_seq: number }>(
        `DELETE FROM payment_cards WHERE payment_card_seq IN (SELECT payment_card_seq FROM payment_cards WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING payment_card_seq`,
      );
      if (cards.rows.length) {
        const ids = cards.rows.map((row) => row.payment_card_seq).sort((a, b) => a - b);
        await enqueue(client, {
          destination: 'order',
          eventType: 'CustomerPaymentCardsPurged',
          aggregateSeq: ids[0],
          payload: { ids },
        });
      }
      await client.query(`DELETE FROM memberships WHERE membership_seq IN (SELECT membership_seq FROM memberships
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM personal_pins WHERE personal_pin_seq IN (SELECT personal_pin_seq FROM personal_pins
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM departments WHERE department_seq IN (SELECT d.department_seq FROM departments d
        WHERE d.deleted_at<=statement_timestamp()-interval '5 years'
         AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.department_seq=d.department_seq) LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM organizations WHERE organization_seq IN (SELECT o.organization_seq FROM organizations o
        WHERE o.deleted_at<=statement_timestamp()-interval '5 years'
         AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_seq=o.organization_seq)
          AND NOT EXISTS(SELECT 1 FROM payment_cards c WHERE c.organization_seq=o.organization_seq)
         AND NOT EXISTS(SELECT 1 FROM departments d WHERE d.organization_seq=o.organization_seq) LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`UPDATE customers SET name='삭제된 고객',phone_number='000'||customer_seq::text,address_data=NULL,
        monthly_billing_enabled=false,anonymized_at=clock_timestamp() WHERE customer_seq IN (SELECT customer_seq FROM customers
         WHERE deleted_at<=statement_timestamp()-interval '5 years' AND anonymized_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      let after = 0,
        removed = 0;
      const cutoff = (
        await client.query<{ cutoff: string }>(
          "SELECT (statement_timestamp()-interval '5 years')::text AS cutoff",
        )
      ).rows[0].cutoff;
      while (removed < 100) {
        const candidates = await client.query<{ customer_seq: number }>(
          `SELECT c.customer_seq FROM customers c WHERE c.customer_seq>$1
           AND c.deleted_at<=$2::timestamptz
           AND NOT EXISTS(SELECT 1 FROM personal_pins p WHERE p.customer_seq=c.customer_seq)
           AND NOT EXISTS(SELECT 1 FROM payment_cards pc WHERE pc.customer_seq=c.customer_seq)
           AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.customer_seq=c.customer_seq)
           ORDER BY c.customer_seq LIMIT 1000 FOR UPDATE OF c SKIP LOCKED`,
          [after, cutoff],
        );
        if (!candidates.rows.length) break;
        const ids = candidates.rows.map((row) => row.customer_seq);
        const url = this.config.get('ORDER_URL', { infer: true });
        if (!url) throw new Error('Order owner unavailable');
        const retained = new Set(
          await requestRetainedCustomers(
            url + '/internal/call-read-references',
            this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
            ids,
          ),
        );
        const eligible = ids.filter((id) => !retained.has(id)).slice(0, 100 - removed);
        if (eligible.length) {
          await client.query('DELETE FROM customers WHERE customer_seq=ANY($1::int[])', [eligible]);
          removed += eligible.length;
        }
        after = ids[ids.length - 1];
        if (ids.length < 1000) break;
      }
      return true;
    });
  }
}
