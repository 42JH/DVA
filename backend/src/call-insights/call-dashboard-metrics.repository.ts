import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import {
  CreateResponseWaitMetricsDto,
  CreateStageMetricsDto,
} from './dto/create-call-dashboard-metrics.dto';

@Injectable()
export class CallDashboardMetricsRepository {
  async lockCall(client: PoolClient, id: number) {
    return (
      await client.query<{ providerCallId: string; hasAnalysis: boolean; durationMs: number }>(
        `SELECT c.provider_call_id AS "providerCallId",a.call_session_seq IS NOT NULL AS "hasAnalysis",
         (extract(epoch FROM (COALESCE(c.ended_at,a.ai_ended_at)-COALESCE(c.started_at,a.ai_started_at)))*1000)::double precision AS "durationMs"
         FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq)
         WHERE c.call_session_seq=$1 AND c.deleted_at IS NULL
          AND (c.incoming_at IS NULL OR c.incoming_at>statement_timestamp()-interval '5 years') FOR SHARE OF c`,
        [id],
      )
    ).rows[0];
  }

  async insert(
    client: PoolClient,
    id: number,
    input: CreateStageMetricsDto | CreateResponseWaitMetricsDto,
    hash: string,
  ): Promise<boolean> {
    const result =
      'dropoffStage' in input
        ? await client.query(
            `INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at)
         VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT(call_session_seq) DO UPDATE
         SET dropoff_stage=EXCLUDED.dropoff_stage,dropoff_payload_hash=EXCLUDED.dropoff_payload_hash,dropoff_received_at=EXCLUDED.dropoff_received_at
         WHERE call_dashboard_metrics.dropoff_payload_hash IS NULL RETURNING call_session_seq`,
            [id, input.dropoffStage, hash],
          )
        : await client.query(
            `INSERT INTO call_dashboard_metrics(call_session_seq,total_wait_ms,latency_stats,response_wait_payload_hash,response_wait_received_at)
         VALUES($1,$2,$3::jsonb,$4,clock_timestamp()) ON CONFLICT(call_session_seq) DO UPDATE
         SET total_wait_ms=EXCLUDED.total_wait_ms,latency_stats=EXCLUDED.latency_stats,
          response_wait_payload_hash=EXCLUDED.response_wait_payload_hash,response_wait_received_at=EXCLUDED.response_wait_received_at
         WHERE call_dashboard_metrics.response_wait_payload_hash IS NULL RETURNING call_session_seq`,
            [id, input.totalWaitMs, JSON.stringify(input.latencyStats), hash],
          );
    return result.rowCount === 1;
  }

  async findHash(client: PoolClient, id: number, dropoff: boolean): Promise<string | null> {
    const result = await client.query<{ hash: string | null }>(
      `SELECT ${dropoff ? 'dropoff_payload_hash' : 'response_wait_payload_hash'} AS hash FROM call_dashboard_metrics WHERE call_session_seq=$1`,
      [id],
    );
    return result.rows[0]?.hash ?? null;
  }
}
