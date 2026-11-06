import type { PoolClient } from 'pg';
import { readPage, type PageRows } from '../common/pagination-query';
import type { TranscriptQueryDto, UtteranceDto } from './dto/transcript.dto';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
@Injectable()
export class ConsultationsRepository {
  constructor(private readonly database: DatabaseService) {}
  async activeCount() {
    const row = (
      await this.database.pool.query<{
        activeCallCount: number;
        observedAt: Date;
      }>(
        `SELECT count(*)::int AS "activeCallCount",statement_timestamp() AS "observedAt"
       FROM call_sessions WHERE registered_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL
        AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')`,
      )
    ).rows[0];
    return {
      activeCallCount: row.activeCallCount,
      observedAt: row.observedAt.toISOString(),
    };
  }

  async lockForDeletion(client: PoolClient, id: number) {
    return (
      await client.query<{ endedAt: Date | null }>(
        `SELECT ended_at AS "endedAt" FROM call_sessions
      WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }

  async recordingInProgress(client: PoolClient, id: number): Promise<boolean> {
    return !!(
      await client.query(
        `SELECT 1 FROM pbx_webhooks.call_ended_events
      WHERE call_session_seq=$1 AND (processing_status<>'PROCESSED' OR claimed_until>clock_timestamp()) LIMIT 1`,
        [id],
      )
    ).rowCount;
  }

  async softDelete(client: PoolClient, id: number): Promise<void> {
    await client.query(
      'UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE call_session_seq=$1',
      [id],
    );
    await client.query("SELECT pg_notify('call_sessions_changed','')");
  }

  async findTranscript(
    id: number,
    query: TranscriptQueryDto,
  ): Promise<PageRows<UtteranceDto>> {
    return await readPage<UtteranceDto>(
      this.database.pool,
      `SELECT u.call_utterance_seq AS "callUtteranceSeq",u.utterance_order AS "utteranceOrder",u.speaker,
       u.utterance_text AS "utteranceText",u.last_sentence_seq AS "lastSentenceSeq",u.received_at AS "receivedAt",
       e.offset_seconds::double precision AS "offsetSeconds"
       FROM call_utterances u LEFT JOIN call_insight_events e ON e.call_utterance_seq=u.call_utterance_seq
        AND e.call_session_seq=u.call_session_seq AND e.kind='UTTERANCE'
       WHERE u.call_session_seq=$1`,
      [id],
      query,
      '"utteranceOrder","callUtteranceSeq"',
    );
  }

  async callExists(id: number): Promise<boolean> {
    return (
      (
        await this.database.pool.query(
          "SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')",
          [id],
        )
      ).rowCount === 1
    );
  }
}
