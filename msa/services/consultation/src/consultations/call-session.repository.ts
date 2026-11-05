import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { callerPhone } from '../common/caller-phone';
import { RecordingCallMatch } from './consultations.types';

@Injectable()
export class CallSessionRepository {
  async attachRecording(
    client: PoolClient,
    callId: number,
    objectKey: string,
  ): Promise<void> {
    const call = await client.query(
      `SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
      AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR SHARE`,
      [callId],
    );
    if (!call.rowCount) throw new Error('recording_call_unavailable');
    await client.query(
      'INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2) ON CONFLICT(object_key) DO NOTHING',
      [callId, objectKey],
    );
    const recording = await client.query(
      'SELECT 1 FROM recordings WHERE object_key=$1 AND call_session_seq=$2',
      [objectKey, callId],
    );
    if (recording.rowCount !== 1)
      throw new Error('recording_assignment_conflict');
  }

  async matchRecording(
    client: PoolClient,
    input: RecordingCallMatch,
  ): Promise<number | null> {
    const candidates = (
      await client.query<{
        id: number;
        startedAt: Date | null;
        endedAt: Date | null;
      }>(
        `SELECT call_session_seq AS id,started_at AS "startedAt",ended_at AS "endedAt" FROM call_sessions
         WHERE caller_phone_number=$1 AND deleted_at IS NULL AND incoming_at>clock_timestamp()-interval '5 years'
           AND incoming_at BETWEEN $2::timestamptz-make_interval(secs=>$3) AND $2::timestamptz+make_interval(secs=>$3)
         ORDER BY incoming_at,call_session_seq LIMIT 2 FOR UPDATE`,
        [
          callerPhone(input.callerPhoneNumber),
          input.startedAt,
          input.windowSeconds,
        ],
      )
    ).rows;
    // 가장 가까운 후보라도 두 건 이상이면 추정 연결하지 않는다.
    if (candidates.length !== 1) return null;
    const call = candidates[0];
    if (
      (call.startedAt && call.startedAt.toISOString() !== input.startedAt) ||
      (call.endedAt && call.endedAt.toISOString() !== input.endedAt)
    )
      throw new Error('recording_call_time_conflict');
    await client.query(
      'UPDATE call_sessions SET started_at=$2,ended_at=$3 WHERE call_session_seq=$1',
      [call.id, input.startedAt, input.endedAt],
    );
    await client.query("SELECT pg_notify('call_sessions_changed','')");
    return call.id;
  }
}
