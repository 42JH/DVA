import { preparedQuery } from '../database/prepared-query';
import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CallActionDto, CallProcessingResultDto } from './dto/call-event-response.dto';
import {
  BusinessResultPayloadDto,
  CallEventInputDto,
  UtterancePayloadDto,
} from './dto/create-call-events.dto';

export interface EventCall {
  providerCallId: string;
  phone: string | null;
  orderSeq: number | null;
}

@Injectable()
export class CallEventsRepository {
  constructor(private readonly database: DatabaseService) {}

  async callExists(id: number): Promise<boolean> {
    return (
      (
        await this.database.pool.query(
          'SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL',
          [id],
        )
      ).rowCount === 1
    );
  }

  async findActions(id: number, query: PaginationQueryDto): Promise<PageRows<CallActionDto>> {
    return await readPage<CallActionDto>(
      this.database.pool,
      `SELECT event_id AS "eventId",event_order AS "eventOrder",occurred_at AS "occurredAt",
         offset_seconds::double precision AS "offsetSeconds",payload->>'action' AS action,
         payload->>'summaryText' AS "summaryText",(payload->>'orderSeq')::integer AS "orderSeq"
         FROM call_insight_events WHERE call_session_seq=$1 AND kind='AI_ACTION'`,
      [id],
      query,
      '"eventOrder","eventId"',
    );
  }

  async findProcessingResults(
    id: number,
    query: PaginationQueryDto,
  ): Promise<PageRows<CallProcessingResultDto>> {
    return await readPage<CallProcessingResultDto>(
      this.database.pool,
      `SELECT e.event_id AS "eventId",e.event_order AS "eventOrder",e.occurred_at AS "occurredAt",
         e.offset_seconds::double precision AS "offsetSeconds",e.payload->>'action' AS action,
         e.payload->>'summaryText' AS "summaryText",(e.payload->>'orderSeq')::integer AS "orderSeq",
         e.unanswered_question_seq AS "unansweredQuestionSeq",
         CASE WHEN u.status IN ('OPEN','REGISTERED') THEN u.reason ELSE NULL END AS "unansweredReason",
         CASE WHEN e.payload->>'action'='FAQ_ANSWERED' THEN question.utterance_text
          WHEN u.status IN ('OPEN','REGISTERED') THEN u.question_text ELSE NULL END AS "questionText",
         answer.utterance_text AS "answerText",
         COALESCE((e.payload->>'faqEntrySeq')::integer,
           CASE WHEN jsonb_array_length(e.payload->'faqEntrySeqs')=1
             THEN (e.payload->'faqEntrySeqs'->>0)::integer END) AS "faqEntrySeq",
         CASE WHEN e.payload->>'action'='FAQ_ANSWERED' THEN COALESCE(e.payload->'faqEntrySeqs',
           jsonb_build_array((e.payload->>'faqEntrySeq')::integer)) END AS "faqEntrySeqs",
         (e.payload->>'questionUtteranceOrder')::integer AS "questionUtteranceOrder",
         (e.payload->>'answerUtteranceOrder')::integer AS "answerUtteranceOrder"
         FROM call_insight_events e
         LEFT JOIN unanswered_questions u ON u.unanswered_question_seq=e.unanswered_question_seq
          AND u.call_session_seq=e.call_session_seq
         LEFT JOIN call_utterances question ON e.payload->>'action'='FAQ_ANSWERED'
          AND question.call_session_seq=e.call_session_seq
          AND question.utterance_order=(e.payload->>'questionUtteranceOrder')::integer
          AND question.speaker='CUSTOMER'
         LEFT JOIN call_utterances answer ON e.payload->>'action'='FAQ_ANSWERED'
          AND answer.call_session_seq=e.call_session_seq
          AND answer.utterance_order=(e.payload->>'answerUtteranceOrder')::integer
          AND answer.speaker='AI'
         WHERE e.call_session_seq=$1 AND e.kind='BUSINESS_RESULT'`,
      [id],
      query,
      '"eventOrder","eventId"',
    );
  }

  async findCall(client: PoolClient, id: number): Promise<EventCall | undefined> {
    // 같은 통화 이벤트를 직렬화하면서 PBX·주문의 일반 갱신과 잠금을 분리한다.
    await client.query(preparedQuery('SELECT pg_advisory_xact_lock(20261031,$1)', [id]));
    return (
      await client.query<EventCall>(
        preparedQuery(
          `SELECT provider_call_id AS "providerCallId",caller_phone_number AS phone,order_seq AS "orderSeq"
       FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
         AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR SHARE`,
          [id],
        ),
      )
    ).rows[0];
  }

  async findExisting(client: PoolClient, callId: number, event: CallEventInputDto) {
    return (
      await client.query<{ eventId: string; callId: number; eventOrder: number; hash: string }>(
        preparedQuery(
          `SELECT event_id AS "eventId",call_session_seq AS "callId",event_order AS "eventOrder",payload_hash AS hash
       FROM call_insight_events WHERE event_id=$1 OR (call_session_seq=$2 AND event_order=$3)`,
          [event.eventId, callId, event.eventOrder],
        ),
      )
    ).rows;
  }

  async orderAccess(
    client: PoolClient,
    orderId: number,
    call: EventCall,
  ): Promise<boolean | undefined> {
    const result = await client.query<{ allowed: boolean | null }>(
      preparedQuery(
        `SELECT o.order_seq=$2 OR o.customer_seq=COALESCE(
         (SELECT customer_seq FROM orders WHERE order_seq=$2 AND deleted_at IS NULL
           AND COALESCE(closed_at,created_at)>clock_timestamp()-interval '5 years'),
         (SELECT customer_seq FROM customers WHERE phone_number=$3 AND deleted_at IS NULL)) AS allowed
       FROM orders o WHERE o.order_seq=$1 AND o.deleted_at IS NULL
         AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years' FOR SHARE OF o`,
        [orderId, call.orderSeq, call.phone],
      ),
    );
    return result.rows[0] ? result.rows[0].allowed === true : undefined;
  }

  async questionCall(client: PoolClient, id: number): Promise<number | undefined> {
    return (
      await client.query<{ call_session_seq: number }>(
        preparedQuery(
          'SELECT call_session_seq FROM unanswered_questions WHERE unanswered_question_seq=$1 FOR KEY SHARE',
          [id],
        ),
      )
    ).rows[0]?.call_session_seq;
  }

  async faqReferences(client: PoolClient, callId: number, payload: BusinessResultPayloadDto) {
    return (
      await client.query<{
        questionSpeaker: string | null;
        answerSpeaker: string | null;
      }>(
        preparedQuery(
          `SELECT
         (SELECT speaker FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$2) AS "questionSpeaker",
         (SELECT speaker FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$3) AS "answerSpeaker"`,
          [callId, payload.questionUtteranceOrder, payload.answerUtteranceOrder],
        ),
      )
    ).rows[0];
  }

  async findOrInsertUtterance(client: PoolClient, callId: number, payload: UtterancePayloadDto) {
    await client.query(
      preparedQuery(
        `INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(call_session_seq,utterance_order) DO NOTHING`,
        [
          callId,
          payload.utteranceOrder,
          payload.speaker,
          payload.utteranceText,
          payload.lastSentenceSeq,
        ],
      ),
    );
    return (
      await client.query<{ id: number; speaker: string; text: string; lastSentenceSeq: number }>(
        preparedQuery(
          `SELECT call_utterance_seq AS id,speaker,utterance_text AS text,last_sentence_seq AS "lastSentenceSeq"
       FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$2 FOR KEY SHARE`,
          [callId, payload.utteranceOrder],
        ),
      )
    ).rows[0];
  }

  async saveFaqQuestionExamples(
    client: PoolClient,
    callId: number,
    events: CallEventInputDto[],
  ): Promise<void> {
    const results = events.flatMap((event) => {
      const payload = event.payload as BusinessResultPayloadDto;
      return (payload.faqEntrySeqs ?? [payload.faqEntrySeq!]).map((id) => ({
        event_id: event.eventId,
        faq_entry_seq: id,
        question_utterance_order: payload.questionUtteranceOrder!,
        occurred_at: event.occurredAt,
      }));
    });
    const ids = [...new Set(results.map((result) => result.faq_entry_seq))];
    // FAQ 수정/삭제와 같은 번호순 잠금을 사용해 여러 통화의 10개 제한을 직렬화한다.
    await client.query(
      preparedQuery(
        `WITH current_faqs AS (
         SELECT faq_entry_seq,updated_at FROM faq_entries
         WHERE faq_entry_seq=ANY($3::int[]) AND deleted_at IS NULL
         ORDER BY faq_entry_seq FOR UPDATE
       ) INSERT INTO faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
       SELECT f.faq_entry_seq,r.event_id,u.utterance_text,r.occurred_at
       FROM jsonb_to_recordset($2::jsonb) AS r(event_id uuid,faq_entry_seq integer,
         question_utterance_order integer,occurred_at timestamptz)
       JOIN current_faqs f ON f.faq_entry_seq=r.faq_entry_seq
       JOIN call_utterances u ON u.call_session_seq=$1 AND u.utterance_order=r.question_utterance_order
       WHERE r.occurred_at>=f.updated_at
         AND r.occurred_at>statement_timestamp()-interval '5 years'
       ORDER BY r.occurred_at,r.event_id
       ON CONFLICT(faq_entry_seq,event_id) DO NOTHING`,
        [callId, JSON.stringify(results), ids],
      ),
    );
    await client.query(
      preparedQuery(
        `DELETE FROM faq_question_examples WHERE faq_entry_seq=ANY($1::int[])
       AND (occurred_at<=statement_timestamp()-interval '5 years' OR faq_question_example_seq IN (
         SELECT faq_question_example_seq FROM (
           SELECT faq_question_example_seq,row_number() OVER(PARTITION BY faq_entry_seq
             ORDER BY occurred_at DESC,faq_question_example_seq DESC) AS position
           FROM faq_question_examples WHERE faq_entry_seq=ANY($1::int[])
         ) ranked WHERE position>10))`,
        [ids],
      ),
    );
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
      preparedQuery(
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
      ),
    );
    return result.rowCount === 1;
  }
}
