import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { OrderSnapshot } from '../orders/order-snapshot';
import { inspectOrder } from '../orders/order-submission.validation';
import { DatabaseService } from '../database/database.service';
import { IncompleteConsultationQueryDto } from './dto/incomplete-consultation-query.dto';

interface SummaryRow {
  incompleteConsultationSeq: number;
  callSessionSeq: number;
  providerCallId: string;
  endedAt: Date;
  endType: string | null;
  systemEvent: string | null;
  missingFields: string[];
  createdAt: Date;
}

const SUMMARY_COLUMNS = `i.incomplete_consultation_seq AS "incompleteConsultationSeq",
 i.call_session_seq AS "callSessionSeq", c.provider_call_id AS "providerCallId",
 i.ended_at AS "endedAt", i.end_type AS "endType", i.system_event AS "systemEvent",
 i.collection_analysis->'missingFields' AS "missingFields", i.created_at AS "createdAt"`;

function summary(row: SummaryRow) {
  return { ...row, endedAt: row.endedAt.toISOString(), createdAt: row.createdAt.toISOString() };
}

@Injectable()
export class IncompleteConsultationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findMany(query: IncompleteConsultationQueryDto) {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.providerCallId !== undefined) {
      values.push(query.providerCallId);
      conditions.push(`c.provider_call_id=$${values.length}`);
    }
    if (query.from !== undefined) {
      values.push(query.from);
      conditions.push(`i.ended_at>=$${values.length}`);
    }
    if (query.to !== undefined) {
      values.push(query.to);
      conditions.push(`i.ended_at<$${values.length}`);
    }
    values.push(query.limit + 1, query.offset);
    const rows = await this.database.pool.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM incomplete_consultations i
       JOIN call_sessions c ON c.call_session_seq=i.call_session_seq
       ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
       ORDER BY i.ended_at DESC,i.incomplete_consultation_seq DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return rows.rows.map(summary);
  }

  async lock(client: PoolClient, providerCallId: string): Promise<boolean> {
    return (
      await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('incomplete-consultation:' || $1,0)) AS locked",
        [providerCallId],
      )
    ).rows[0].locked;
  }

  async call(client: PoolClient, providerCallId: string) {
    await client.query(
      'INSERT INTO call_sessions(provider_call_id) VALUES($1) ON CONFLICT(provider_call_id) DO NOTHING',
      [providerCallId],
    );
    return (
      await client.query<{ id: number; orderSeq: number | null; startedAt: Date | null }>(
        'SELECT call_session_seq AS id, order_seq AS "orderSeq", started_at AS "startedAt" FROM call_sessions WHERE provider_call_id=$1 FOR UPDATE',
        [providerCallId],
      )
    ).rows[0];
  }

  async previous(client: PoolClient, callId: number) {
    return (
      await client.query<{
        incompleteConsultationSeq: number;
        callSessionSeq: number;
        requestHash: string;
      }>(
        'SELECT incomplete_consultation_seq AS "incompleteConsultationSeq", call_session_seq AS "callSessionSeq", request_hash AS "requestHash" FROM incomplete_consultations WHERE call_session_seq=$1',
        [callId],
      )
    ).rows[0];
  }

  async insert(
    client: PoolClient,
    callId: number,
    input: {
      eventId: string;
      endedAt: string;
      endType: string | null;
      systemEvent: string | null;
      snapshot: OrderSnapshot;
    },
    analysis: ReturnType<typeof inspectOrder>,
    hash: string,
  ) {
    return (
      await client.query<{ incompleteConsultationSeq: number; callSessionSeq: number }>(
        `INSERT INTO incomplete_consultations(call_session_seq,event_id,ended_at,end_type,system_event,order_snapshot,collection_analysis,request_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING incomplete_consultation_seq AS "incompleteConsultationSeq",call_session_seq AS "callSessionSeq"`,
        [
          callId,
          input.eventId,
          input.endedAt,
          input.endType,
          input.systemEvent,
          input.snapshot,
          analysis,
          hash,
        ],
      )
    ).rows[0];
  }
}
