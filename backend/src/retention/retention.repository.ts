import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

export interface CallPurge {
  id: number;
  phone: string | null;
  claimId: string;
  keys: string[];
}

@Injectable()
export class RetentionRepository {
  constructor(private readonly database: DatabaseService) {}

  async claimCall(): Promise<CallPurge | undefined> {
    // A statement-stable expiry cutoff lets time indexes bound the scan.
    const candidates = await this.database.pool.query<{ id: number; phone: string | null }>(
      `SELECT call_session_seq AS id,caller_phone_number AS phone FROM call_sessions
       WHERE incoming_at<=statement_timestamp()-interval '5 years'
        AND (purge_claimed_until IS NULL OR purge_claimed_until<=clock_timestamp())
       ORDER BY incoming_at,call_session_seq LIMIT 10`,
    );
    for (const candidate of candidates.rows) {
      const claim = await this.database.transaction(async (client) => {
        // Match the registration/PBX lock order; never hold it during S3 requests.
        if (
          !(
            await client.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_xact_lock(hashtextextended('call-end:' || COALESCE($1,''),0)) AS locked",
              [candidate.phone],
            )
          ).rows[0].locked
        )
          return;
        const receipts = await client.query<{ recordingId: string; busy: boolean }>(
          `SELECT recording_id AS "recordingId",COALESCE(claimed_until>clock_timestamp(),false) AS busy
           FROM pbx_webhooks.call_ended_events WHERE call_session_seq=$1 FOR UPDATE SKIP LOCKED`,
          [candidate.id],
        );
        const count = (
          await client.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM pbx_webhooks.call_ended_events WHERE call_session_seq=$1',
            [candidate.id],
          )
        ).rows[0].count;
        if (receipts.rows.length !== count || receipts.rows.some((row) => row.busy)) return;
        const call = await client.query(
          `SELECT 1 FROM call_sessions WHERE call_session_seq=$1
          AND incoming_at<=statement_timestamp()-interval '5 years'
          AND (purge_claimed_until IS NULL OR purge_claimed_until<=clock_timestamp()) FOR UPDATE SKIP LOCKED`,
          [candidate.id],
        );
        if (!call.rowCount) return;
        const claimId = randomUUID();
        await client.query(
          `UPDATE call_sessions SET purge_claim_id=$2,purge_claimed_until=clock_timestamp()+interval '5 minutes'
          WHERE call_session_seq=$1`,
          [candidate.id, claimId],
        );
        const objects = await client.query<{ key: string }>(
          'SELECT object_key AS key FROM recordings WHERE call_session_seq=$1',
          [candidate.id],
        );
        // A successful upload can precede the recording INSERT if the process stops.
        const keys = [
          ...new Set([
            ...objects.rows.map((row) => row.key),
            ...receipts.rows.map(
              (row) => `recordings/${createHash('sha256').update(row.recordingId).digest('hex')}`,
            ),
          ]),
        ];
        return { ...candidate, claimId, keys };
      });
      if (claim) return claim;
    }
  }

  async renew(claim: CallPurge): Promise<boolean> {
    return !!(
      await this.database.pool.query(
        `UPDATE call_sessions SET purge_claimed_until=clock_timestamp()+interval '5 minutes'
      WHERE call_session_seq=$1 AND purge_claim_id=$2 AND purge_claimed_until>clock_timestamp()`,
        [claim.id, claim.claimId],
      )
    ).rowCount;
  }

  async defer(claim: CallPurge): Promise<void> {
    await this.database.pool.query(
      `UPDATE call_sessions SET purge_claimed_until=clock_timestamp()+interval '1 minute'
      WHERE call_session_seq=$1 AND purge_claim_id=$2`,
      [claim.id, claim.claimId],
    );
  }

  async finishCall(claim: CallPurge): Promise<boolean> {
    return this.database.transaction(async (client) => {
      if (
        !(
          await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('call-end:' || COALESCE($1,''),0)) AS locked",
            [claim.phone],
          )
        ).rows[0].locked
      )
        return false;
      const call = await client.query(
        `SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND purge_claim_id=$2
        AND purge_claimed_until>clock_timestamp() AND incoming_at<=statement_timestamp()-interval '5 years' FOR UPDATE`,
        [claim.id, claim.claimId],
      );
      if (!call.rowCount) return false;
      await client.query('DELETE FROM call_insight_events WHERE call_session_seq=$1', [claim.id]);
      await client.query('DELETE FROM unanswered_questions WHERE call_session_seq=$1', [claim.id]);
      await client.query('DELETE FROM call_utterances WHERE call_session_seq=$1', [claim.id]);
      await client.query('DELETE FROM call_analyses WHERE call_session_seq=$1', [claim.id]);
      await client.query('DELETE FROM recordings WHERE call_session_seq=$1', [claim.id]);
      await client.query('DELETE FROM empty_ai_order_results WHERE call_session_seq=$1', [
        claim.id,
      ]);
      await client.query('DELETE FROM pbx_webhooks.call_ended_events WHERE call_session_seq=$1', [
        claim.id,
      ]);
      await client.query('DELETE FROM call_sessions WHERE call_session_seq=$1', [claim.id]);
      await client.query("SELECT pg_notify('call_sessions_changed','')");
      return true;
    });
  }

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
      await client.query(`DELETE FROM audit_logs WHERE audit_log_seq IN (SELECT audit_log_seq FROM audit_logs
        WHERE occurred_at<=statement_timestamp()-interval '7 days' ORDER BY occurred_at,audit_log_seq LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM faq_change_notifications WHERE faq_change_notification_seq IN (
        SELECT faq_change_notification_seq FROM faq_change_notifications WHERE sent_at<=statement_timestamp()-interval '7 days'
        ORDER BY sent_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      await client.query(`UPDATE ai_persona_versions SET created_by_admin_user_name=NULL WHERE ai_persona_version_seq IN (
        SELECT ai_persona_version_seq FROM ai_persona_versions WHERE created_at<=statement_timestamp()-interval '5 years'
         AND created_by_admin_user_name IS NOT NULL LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      const orders = await client.query<{ id: number }>(`SELECT o.order_seq AS id FROM orders o
        WHERE COALESCE(o.closed_at,o.created_at)<=statement_timestamp()-interval '5 years'
         AND o.status IN ('COLLECTING','notPaid','CANCELLED','ACCEPTED','SUBMISSION_FAILED')
         AND NOT EXISTS(SELECT 1 FROM call_sessions c WHERE c.order_seq=o.order_seq)
         AND NOT EXISTS(SELECT 1 FROM order_payment_requests r WHERE r.order_seq=o.order_seq
          AND ((r.approval_started_at IS NOT NULL AND r.completed_at IS NULL AND r.invalidated_at IS NULL)
           OR r.notification_status='SENDING' OR r.completion_notification_status='SENDING'))
        ORDER BY COALESCE(o.closed_at,o.created_at),o.order_seq LIMIT 10 FOR UPDATE OF o SKIP LOCKED`);
      for (const order of orders.rows) {
        const requests = await client.query<{ busy: boolean }>(
          `SELECT
          ((approval_started_at IS NOT NULL AND completed_at IS NULL AND invalidated_at IS NULL)
           OR notification_status='SENDING' OR completion_notification_status='SENDING') AS busy
          FROM order_payment_requests WHERE order_seq=$1 ORDER BY payment_request_id FOR UPDATE`,
          [order.id],
        );
        if (requests.rows.some((row) => row.busy)) continue;
        await client.query("SELECT set_config('dva.retention_order',$1,true)", [String(order.id)]);
        await client.query(
          `DELETE FROM shipment_status_history WHERE shipment_seq IN (
          SELECT s.shipment_seq FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1)`,
          [order.id],
        );
        await client.query(
          'DELETE FROM shipments WHERE order_parcel_seq IN (SELECT order_parcel_seq FROM order_parcels WHERE order_seq=$1)',
          [order.id],
        );
        await client.query('DELETE FROM order_parcels WHERE order_seq=$1', [order.id]);
        await client.query('DELETE FROM order_payment_requests WHERE order_seq=$1', [order.id]);
        await client.query('DELETE FROM order_billing_charges WHERE order_seq=$1', [order.id]);
        await client.query('DELETE FROM orders WHERE order_seq=$1', [order.id]);
      }
      // Child references remain valid until their own roots are expired.
      await client.query(`DELETE FROM memberships WHERE membership_seq IN (SELECT membership_seq FROM memberships
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM personal_pins WHERE personal_pin_seq IN (SELECT personal_pin_seq FROM personal_pins
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM company_pins WHERE company_pin_seq IN (SELECT company_pin_seq FROM company_pins
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM departments WHERE department_seq IN (SELECT d.department_seq FROM departments d
        WHERE d.deleted_at<=statement_timestamp()-interval '5 years'
         AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.department_seq=d.department_seq)
         AND NOT EXISTS(SELECT 1 FROM company_pins p WHERE p.department_seq=d.department_seq) LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM organizations WHERE organization_seq IN (SELECT o.organization_seq FROM organizations o
        WHERE o.deleted_at<=statement_timestamp()-interval '5 years'
         AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.organization_seq=o.organization_seq)
         AND NOT EXISTS(SELECT 1 FROM company_pins p WHERE p.organization_seq=o.organization_seq)
         AND NOT EXISTS(SELECT 1 FROM departments d WHERE d.organization_seq=o.organization_seq) LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`UPDATE customers SET name='삭제된 고객',phone_number='000'||customer_seq::text,address_data=NULL,
        monthly_billing_enabled=false,anonymized_at=clock_timestamp() WHERE customer_seq IN (SELECT customer_seq FROM customers
         WHERE deleted_at<=statement_timestamp()-interval '5 years' AND anonymized_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM customers WHERE customer_seq IN (SELECT c.customer_seq FROM customers c
        WHERE c.deleted_at<=statement_timestamp()-interval '5 years'
         AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.customer_seq=c.customer_seq)
         AND NOT EXISTS(SELECT 1 FROM personal_pins p WHERE p.customer_seq=c.customer_seq)
         AND NOT EXISTS(SELECT 1 FROM memberships m WHERE m.customer_seq=c.customer_seq) LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM admin_users WHERE admin_user_seq IN (SELECT admin_user_seq FROM admin_users
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM faq_entries WHERE faq_entry_seq IN (SELECT faq_entry_seq FROM faq_entries
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM organization_billing_months b WHERE (b.organization_seq,b.billing_month) IN (
        SELECT organization_seq,billing_month FROM organization_billing_months m
        WHERE m.billing_month+interval '5 years 1 month'<=statement_timestamp()
         AND NOT EXISTS(SELECT 1 FROM order_billing_charges c WHERE c.organization_seq=m.organization_seq AND c.billing_month=m.billing_month)
        LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM faq_question_examples WHERE faq_question_example_seq IN (
        SELECT faq_question_example_seq FROM faq_question_examples
        WHERE occurred_at<=statement_timestamp()-interval '5 years'
        ORDER BY occurred_at,faq_question_example_seq LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    });
  }
}
