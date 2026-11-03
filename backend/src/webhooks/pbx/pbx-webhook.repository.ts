import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { CallEndedPayload } from './pbx-webhook.payload';
import { ConsultationsService } from '../../consultations/consultations.service';
import { randomUUID } from 'node:crypto';

@Injectable()
export class PbxWebhookRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly calls: ConsultationsService,
  ) {}

  async next(storageConfigured: boolean) {
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
           AND ($2::boolean OR call_session_seq IS NULL)
           AND ((call_session_seq IS NULL AND received_at<=clock_timestamp()-interval '30 minutes')
             OR last_attempt_at IS NULL OR last_attempt_at<clock_timestamp()-interval '1 minute')
           AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
         ORDER BY (call_session_seq IS NULL AND received_at<=clock_timestamp()-interval '30 minutes') DESC,
           last_attempt_at NULLS FIRST,received_at,recording_id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING recording_id AS "recordingId",payload,claim_id AS "claimId"`,
        [randomUUID(), storageConfigured],
      )
    ).rows[0];
  }

  async match(
    payload: CallEndedPayload,
    windowSeconds: number,
    claimId: string,
  ): Promise<number | null> {
    return this.database.transaction((client) =>
      this.calls.matchCallEnd(client, payload, windowSeconds, claimId),
    );
  }

  matchReceived(payload: CallEndedPayload): Promise<number | null> {
    return this.database.transaction((client) => this.calls.matchCallEnd(client, payload));
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
      await this.calls.attachRecording(client, callId, objectKey);
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

  async discardExpired(recordingId: string, claimId: string): Promise<void> {
    await this.database.pool.query(
      `DELETE FROM pbx_webhooks.call_ended_events
       WHERE recording_id=$1 AND claim_id=$2 AND claimed_until>clock_timestamp()
         AND call_session_seq IS NULL AND processing_status<>'PROCESSED'
         AND received_at<=clock_timestamp()-interval '30 minutes'`,
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
