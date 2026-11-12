import { Injectable } from '@nestjs/common';
import { enqueue } from '@dva/events';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class RetentionRepository {
  constructor(private readonly database: DatabaseService) {}

  async purgeDatabase(): Promise<void> {
    await this.database.transaction(async (client) => {
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261103,157) AS locked',
          )
        ).rows[0].locked
      )
        return;
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261027,37) AS locked',
          )
        ).rows[0].locked
      )
        return;
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
    });
  }
}
