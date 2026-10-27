import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { OrderSnapshot } from '../orders/order-snapshot';
import { inspectOrder } from '../orders/order-submission.validation';

@Injectable()
export class IncompleteConsultationsRepository {
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
