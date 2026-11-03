import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { callerPhone } from '../common/caller-phone';
import { Environment } from '../config/environment';
import { CallEndedPayload, parseCallEndedPayload } from '../webhooks/pbx/pbx-webhook.payload';
import { CallSessionRepository } from './call-session.repository';

@Injectable()
export class CallEndRepository {
  constructor(
    private readonly sessions: CallSessionRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async lockCaller(client: PoolClient, phone: string): Promise<void> {
    // 등록·웹훅·워커가 수신함과 통화를 잠그기 전에 같은 번호의 매칭을 직렬화한다.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('call-end:' || $1,0))", [
      callerPhone(phone),
    ]);
  }

  async match(
    client: PoolClient,
    payload: CallEndedPayload,
    windowSeconds = this.config.get('RECORDING_MATCH_WINDOW_SECONDS', { infer: true }),
    claimId?: string,
  ): Promise<number | null> {
    await this.lockCaller(client, payload.callFrom);
    const event = (
      await client.query<{ callId: number | null }>(
        `SELECT call_session_seq AS "callId" FROM pbx_webhooks.call_ended_events
         WHERE recording_id=$1 AND ($2::uuid IS NULL OR (claim_id=$2 AND claimed_until>clock_timestamp()))
         FOR UPDATE`,
        [payload.recordingId, claimId ?? null],
      )
    ).rows[0];
    if (!event) return null;
    if (event.callId !== null) return event.callId;
    const callId = await this.sessions.matchRecording(client, {
      callerPhoneNumber: payload.callFrom,
      startedAt: payload.startedAt,
      endedAt: payload.endedAt,
      windowSeconds,
    });
    if (callId !== null)
      await client.query(
        'UPDATE pbx_webhooks.call_ended_events SET call_session_seq=$2 WHERE recording_id=$1',
        [payload.recordingId, callId],
      );
    return callId;
  }

  async matchPending(client: PoolClient, phone: string, incomingAt: string): Promise<void> {
    const normalized = callerPhone(phone);
    const phones = normalized.startsWith('0')
      ? [normalized, '+82' + normalized.slice(1), '0082' + normalized.slice(1)]
      : [normalized];
    const window = this.config.get('RECORDING_MATCH_WINDOW_SECONDS', { infer: true }) * 1000;
    const incoming = Date.parse(incomingAt);
    const pending = await client.query<{ payload: unknown }>(
      `SELECT payload FROM pbx_webhooks.call_ended_events
       WHERE call_session_seq IS NULL AND processing_status<>'PROCESSED'
         AND payload->>'callFrom'=ANY($1::text[]) AND payload->>'startedAt' BETWEEN $2 AND $3
       ORDER BY received_at,recording_id`,
      [
        phones,
        new Date(incoming - window).toISOString(),
        new Date(incoming + window).toISOString(),
      ],
    );
    for (const event of pending.rows) {
      let payload: CallEndedPayload;
      try {
        payload = parseCallEndedPayload(event.payload);
      } catch {
        continue;
      }
      try {
        await this.match(client, payload);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'recording_call_time_conflict')
          throw error;
      }
    }
  }
}
