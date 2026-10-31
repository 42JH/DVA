import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CallEventInputDto, UtterancePayloadDto } from './dto/create-call-events.dto';

export interface EventCall {
  providerCallId: string;
  phone: string | null;
  orderSeq: number | null;
}

@Injectable()
export class CallEventsRepository {
  async findCall(client: PoolClient, id: number): Promise<EventCall | undefined> {
    // 같은 통화 이벤트를 직렬화하면서 PBX·주문의 일반 갱신과 잠금을 분리한다.
    await client.query('SELECT pg_advisory_xact_lock(20261031,$1)', [id]);
    return (
      await client.query<EventCall>(
        `SELECT provider_call_id AS "providerCallId",caller_phone_number AS phone,order_seq AS "orderSeq"
       FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE`,
        [id],
      )
    ).rows[0];
  }

  async findExisting(client: PoolClient, callId: number, event: CallEventInputDto) {
    return (
      await client.query<{ eventId: string; callId: number; eventOrder: number; hash: string }>(
        `SELECT event_id AS "eventId",call_session_seq AS "callId",event_order AS "eventOrder",payload_hash AS hash
       FROM call_insight_events WHERE event_id=$1 OR (call_session_seq=$2 AND event_order=$3)`,
        [event.eventId, callId, event.eventOrder],
      )
    ).rows;
  }

  async orderAccess(
    client: PoolClient,
    orderId: number,
    call: EventCall,
  ): Promise<boolean | undefined> {
    const result = await client.query<{ allowed: boolean | null }>(
      `SELECT o.order_seq=$2 OR o.customer_seq=COALESCE(
         (SELECT customer_seq FROM orders WHERE order_seq=$2),
         (SELECT customer_seq FROM customers WHERE phone_number=$3)) AS allowed
       FROM orders o WHERE o.order_seq=$1 FOR KEY SHARE OF o`,
      [orderId, call.orderSeq, call.phone],
    );
    return result.rows[0] ? result.rows[0].allowed === true : undefined;
  }

  async questionCall(client: PoolClient, id: number): Promise<number | undefined> {
    return (
      await client.query<{ call_session_seq: number }>(
        'SELECT call_session_seq FROM unanswered_questions WHERE unanswered_question_seq=$1 FOR KEY SHARE',
        [id],
      )
    ).rows[0]?.call_session_seq;
  }

  async findOrInsertUtterance(client: PoolClient, callId: number, payload: UtterancePayloadDto) {
    await client.query(
      `INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(call_session_seq,utterance_order) DO NOTHING`,
      [
        callId,
        payload.utteranceOrder,
        payload.speaker,
        payload.utteranceText,
        payload.lastSentenceSeq,
      ],
    );
    return (
      await client.query<{ id: number; speaker: string; text: string; lastSentenceSeq: number }>(
        `SELECT call_utterance_seq AS id,speaker,utterance_text AS text,last_sentence_seq AS "lastSentenceSeq"
       FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$2 FOR KEY SHARE`,
        [callId, payload.utteranceOrder],
      )
    ).rows[0];
  }

  async insert(
    client: PoolClient,
    callId: number,
    event: CallEventInputDto,
    hash: string,
    utteranceId: number | null,
    questionId: number | null,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,offset_seconds,
       call_utterance_seq,unanswered_question_seq,payload,payload_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT DO NOTHING RETURNING call_insight_event_seq`,
      [
        event.eventId,
        callId,
        event.eventOrder,
        event.kind,
        event.occurredAt,
        event.offsetSeconds,
        utteranceId,
        questionId,
        event.kind === 'UTTERANCE' ? null : JSON.stringify(event.payload),
        hash,
      ],
    );
    return result.rowCount === 1;
  }
}
