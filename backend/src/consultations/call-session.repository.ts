import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { callerPhone } from '../common/caller-phone';
import { CallIdentityDto } from './dto/call-identity.dto';
import { RecordingCallMatch } from './consultations.types';

@Injectable()
export class CallSessionRepository {
  async attachRecording(client: PoolClient, callId: number, objectKey: string): Promise<void> {
    await client.query(
      'INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2) ON CONFLICT(object_key) DO NOTHING',
      [callId, objectKey],
    );
    const recording = await client.query(
      'SELECT 1 FROM recordings WHERE object_key=$1 AND call_session_seq=$2',
      [objectKey, callId],
    );
    if (recording.rowCount !== 1) throw new Error('recording_assignment_conflict');
  }

  async attachOrder(client: PoolClient, callId: number, orderId: number): Promise<void> {
    await client.query('UPDATE call_sessions SET order_seq=$2 WHERE call_session_seq=$1', [
      callId,
      orderId,
    ]);
  }

  async matchRecording(client: PoolClient, input: RecordingCallMatch): Promise<number | null> {
    const candidates = (
      await client.query<{ id: number; startedAt: Date | null; endedAt: Date | null }>(
        `SELECT call_session_seq AS id,started_at AS "startedAt",ended_at AS "endedAt" FROM call_sessions
         WHERE caller_phone_number=$1 AND incoming_at BETWEEN $2::timestamptz-make_interval(secs=>$3) AND $2::timestamptz+make_interval(secs=>$3)
         ORDER BY incoming_at,call_session_seq LIMIT 2 FOR UPDATE`,
        [callerPhone(input.callerPhoneNumber), input.startedAt, input.windowSeconds],
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
    return call.id;
  }

  async ensureCall(
    client: PoolClient,
    input: CallIdentityDto & { callerPhoneNumber: string },
  ): Promise<{ id: number; created: boolean }> {
    const phone = callerPhone(input.callerPhoneNumber);
    const inserted = await client.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at)
       VALUES($1,$2,$3) ON CONFLICT(provider_call_id) DO NOTHING`,
      [input.providerCallId, phone, input.incomingAt],
    );
    const call = (
      await client.query<{ id: number; matches: boolean }>(
        `SELECT call_session_seq AS id,
         caller_phone_number=$2 AND incoming_at=$3::timestamptz AS matches
       FROM call_sessions WHERE provider_call_id=$1 FOR UPDATE`,
        [input.providerCallId, phone, input.incomingAt],
      )
    ).rows[0];
    if (!call.matches)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '같은 세션의 발신번호·수신 이벤트 시각은 변경할 수 없습니다.',
      );
    return { id: call.id, created: inserted.rowCount === 1 };
  }
}
