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
    const candidates = await this.database.pool.query<{
      id: number;
      phone: string | null;
    }>(
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
        const receipts = await client.query<{
          recordingId: string;
          busy: boolean;
        }>(
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
        if (
          receipts.rows.length !== count ||
          receipts.rows.some((row) => row.busy)
        )
          return;
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
              (row) =>
                `recordings/${createHash('sha256').update(row.recordingId).digest('hex')}`,
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
}
