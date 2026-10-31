import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CallEndedPayload } from './pbx-webhook.payload';
import { callerPhone } from '../../common/caller-phone';
import { randomUUID } from 'node:crypto';

@Injectable()
export class PbxWebhookRepository {
  constructor(private readonly database: DatabaseService) {}

  async next() {
    // 짧은 도착 순서 역전을 기다린다. 실패한 한 건이 뒤의 수신을 계속 막지 않게 순환한다.
    // 5분 lease는 저장소의 HEAD·다운로드·업로드 제한(최대 150초)보다 길게 둔다.
    return (
      await this.database.pool.query<{
        recordingId: string;
        payload: unknown;
        claimId: string;
      }>(
        `UPDATE pbx_webhooks.call_ended_events SET last_attempt_at=clock_timestamp(),
          claim_id=$1,claimed_until=clock_timestamp()+interval '5 minutes'
       WHERE recording_id=(SELECT recording_id FROM pbx_webhooks.call_ended_events
         WHERE processing_status<>'PROCESSED' AND received_at<clock_timestamp()-interval '1 minute'
           AND (last_attempt_at IS NULL OR last_attempt_at<clock_timestamp()-interval '1 minute')
           AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
         ORDER BY last_attempt_at NULLS FIRST,received_at,recording_id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING recording_id AS "recordingId",payload,claim_id AS "claimId"`,
        [randomUUID()],
      )
    ).rows[0];
  }

  async match(
    payload: CallEndedPayload,
    windowSeconds: number,
    claimId: string,
  ): Promise<number | null> {
    return this.database.transaction(async (client) => {
      const event = (
        await client.query<{ callId: number | null }>(
          `SELECT call_session_seq AS "callId" FROM pbx_webhooks.call_ended_events
           WHERE recording_id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp() FOR UPDATE`,
          [payload.recordingId, claimId],
        )
      ).rows[0];
      if (!event) return null;
      if (event.callId !== null) return event.callId;
      const candidates = (
        await client.query<{ id: number; startedAt: Date | null; endedAt: Date | null }>(
          `SELECT call_session_seq AS id,started_at AS "startedAt",ended_at AS "endedAt" FROM call_sessions
         WHERE caller_phone_number=$1 AND incoming_at BETWEEN $2::timestamptz-make_interval(secs=>$3) AND $2::timestamptz+make_interval(secs=>$3)
         ORDER BY incoming_at,call_session_seq LIMIT 2 FOR UPDATE`,
          [callerPhone(payload.callFrom), payload.startedAt, windowSeconds],
        )
      ).rows;
      // 가장 가까운 후보라도 두 건 이상이면 추정 연결하지 않는다.
      if (candidates.length !== 1) return null;
      const call = candidates[0];
      if (
        (call.startedAt && call.startedAt.toISOString() !== payload.startedAt) ||
        (call.endedAt && call.endedAt.toISOString() !== payload.endedAt)
      )
        throw new Error('recording_call_time_conflict');
      await client.query(
        'UPDATE call_sessions SET started_at=$2,ended_at=$3 WHERE call_session_seq=$1',
        [call.id, payload.startedAt, payload.endedAt],
      );
      await client.query(
        'UPDATE pbx_webhooks.call_ended_events SET call_session_seq=$2 WHERE recording_id=$1',
        [payload.recordingId, call.id],
      );
      return call.id;
    });
  }

  async processed(
    recordingId: string,
    callId: number,
    objectKey: string,
    claimId: string,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const event = await client.query(
        `SELECT recording_id FROM pbx_webhooks.call_ended_events
         WHERE recording_id=$1 AND call_session_seq=$2 AND claim_id=$3
           AND claimed_until>clock_timestamp() FOR UPDATE`,
        [recordingId, callId, claimId],
      );
      if (event.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2) ON CONFLICT(object_key) DO NOTHING`,
        [callId, objectKey],
      );
      const recording = await client.query(
        'SELECT 1 FROM recordings WHERE object_key=$1 AND call_session_seq=$2',
        [objectKey, callId],
      );
      if (recording.rowCount !== 1) throw new Error('recording_assignment_conflict');
      await client.query(
        "UPDATE pbx_webhooks.call_ended_events SET processing_status='PROCESSED',claim_id=NULL,claimed_until=NULL WHERE recording_id=$1",
        [recordingId],
      );
      return true;
    });
  }

  async failed(recordingId: string, claimId: string): Promise<void> {
    await this.database.pool.query(
      `UPDATE pbx_webhooks.call_ended_events SET processing_status='FAILED',claim_id=NULL,claimed_until=NULL
       WHERE recording_id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp() AND processing_status<>'PROCESSED'`,
      [recordingId, claimId],
    );
  }

  async release(recordingId: string, claimId: string): Promise<void> {
    await this.database.pool.query(
      'UPDATE pbx_webhooks.call_ended_events SET claim_id=NULL,claimed_until=NULL WHERE recording_id=$1 AND claim_id=$2',
      [recordingId, claimId],
    );
  }

  async insert(recordingId: string, payload: string): Promise<boolean> {
    const result = await this.database.pool.query(
      `INSERT INTO pbx_webhooks.call_ended_events (recording_id, payload)
       VALUES ($1, $2::jsonb) ON CONFLICT (recording_id) DO NOTHING RETURNING recording_id`,
      [recordingId, payload],
    );
    return result.rowCount === 1;
  }

  async hasSamePayload(recordingId: string, payload: string): Promise<boolean> {
    // A fresh READ COMMITTED snapshot sees the winning concurrent insert after it commits.
    const result = await this.database.pool.query<{ same: boolean }>(
      `SELECT payload = $2::jsonb AS same FROM pbx_webhooks.call_ended_events WHERE recording_id = $1`,
      [recordingId, payload],
    );
    return result.rows[0]?.same === true;
  }
}
