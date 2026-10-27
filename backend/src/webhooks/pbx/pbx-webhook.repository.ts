import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { PoolClient } from 'pg';
import { CallEndedPayload } from './pbx-webhook.payload';
import { callerPhone } from '../../common/caller-phone';

@Injectable()
export class PbxWebhookRepository {
  constructor(private readonly database: DatabaseService) {}

  async next(client: PoolClient) {
    // 짧은 도착 순서 역전을 기다린다. 실패한 한 건이 뒤의 수신을 계속 막지 않게 순환한다.
    return (
      await client.query<{ recordingId: string; payload: unknown; callSessionSeq: number | null }>(
        `UPDATE pbx_webhooks.call_ended_events SET last_attempt_at=clock_timestamp()
       WHERE recording_id=(SELECT recording_id FROM pbx_webhooks.call_ended_events
         WHERE processing_status<>'PROCESSED' AND received_at<clock_timestamp()-interval '1 minute'
           AND (last_attempt_at IS NULL OR last_attempt_at<clock_timestamp()-interval '1 minute')
         ORDER BY last_attempt_at NULLS FIRST,received_at,recording_id LIMIT 1)
       RETURNING recording_id AS "recordingId",payload,call_session_seq AS "callSessionSeq"`,
      )
    ).rows[0];
  }

  async match(payload: CallEndedPayload, windowSeconds: number): Promise<number | null> {
    return this.database.transaction(async (client) => {
      const event = (
        await client.query<{ callId: number | null }>(
          `SELECT call_session_seq AS "callId" FROM pbx_webhooks.call_ended_events WHERE recording_id=$1 FOR UPDATE`,
          [payload.recordingId],
        )
      ).rows[0];
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

  async processed(recordingId: string, callId: number, objectKey: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const event = await client.query(
        'SELECT recording_id FROM pbx_webhooks.call_ended_events WHERE recording_id=$1 AND call_session_seq=$2 FOR UPDATE',
        [recordingId, callId],
      );
      if (event.rowCount !== 1) throw new Error('recording_assignment_changed');
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
        "UPDATE pbx_webhooks.call_ended_events SET processing_status='PROCESSED' WHERE recording_id=$1",
        [recordingId],
      );
    });
  }

  async failed(recordingId: string): Promise<void> {
    await this.database.pool.query(
      "UPDATE pbx_webhooks.call_ended_events SET processing_status='FAILED' WHERE recording_id=$1 AND processing_status<>'PROCESSED'",
      [recordingId],
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
