import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { CustomerContextClient } from '../customers/customer-context.client';
import { OrderReferenceScopeService } from './order-reference-scope.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import {
  CallActionDto,
  CallProcessingResultDto,
} from './dto/call-event-response.dto';
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

const requiredCall = {
  existsSql: `SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
    AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')`,
  missing: () =>
    new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.'),
};

@Injectable()
export class CallEventsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly customer: CustomerContextClient,
    private readonly references: OrderReferenceScopeService,
    private readonly audit: AuditService,
  ) {}

  async findActions(
    id: number,
    query: PaginationQueryDto,
  ): Promise<PageRows<CallActionDto>> {
    return await readPage<CallActionDto>(
      this.database.pool,
      `SELECT event_id AS "eventId",event_order AS "eventOrder",occurred_at AS "occurredAt",
         offset_seconds::double precision AS "offsetSeconds",payload->>'action' AS action,
         payload->>'summaryText' AS "summaryText",(payload->>'orderSeq')::integer AS "orderSeq"
         FROM call_insight_events WHERE call_session_seq=$1 AND kind='AI_ACTION'`,
      [id],
      query,
      '"eventOrder","eventId"',
      requiredCall,
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
      requiredCall,
    );
  }

  async findCall(
    client: PoolClient,
    id: number,
  ): Promise<EventCall | undefined> {
    // 같은 통화 이벤트를 직렬화하면서 PBX·주문의 일반 갱신과 잠금을 분리한다.
    await client.query('SELECT pg_advisory_xact_lock(20261031,$1)', [id]);
    return (
      await client.query<EventCall>(
        `SELECT provider_call_id AS "providerCallId",caller_phone_number AS phone,order_seq AS "orderSeq"
       FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
         AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR SHARE`,
        [id],
      )
    ).rows[0];
  }

  async findExisting(
    client: PoolClient,
    callId: number,
    event: CallEventInputDto,
  ) {
    return (
      await client.query<{
        eventId: string;
        callId: number;
        eventOrder: number;
        hash: string;
      }>(
        `SELECT event_id AS "eventId",call_session_seq AS "callId",event_order AS "eventOrder",payload_hash AS hash
       FROM call_insight_events WHERE event_id=$1 OR (call_session_seq=$2 AND event_order=$3)`,
        [event.eventId, callId, event.eventOrder],
      )
    ).rows;
  }

  async orderAccess(
    _client: PoolClient,
    orderId: number,
    call: EventCall,
  ): Promise<boolean | undefined> {
    return this.references.check({
      orderSeq: orderId,
      callOrderSeq: call.orderSeq,
      customerSeq:
        call.phone === null
          ? null
          : await this.customer.callCustomer(call.phone),
    });
  }

  async questionCall(
    client: PoolClient,
    id: number,
  ): Promise<number | undefined> {
    return (
      await client.query<{ call_session_seq: number }>(
        'SELECT call_session_seq FROM unanswered_questions WHERE unanswered_question_seq=$1 FOR KEY SHARE',
        [id],
      )
    ).rows[0]?.call_session_seq;
  }

  async faqReferences(
    client: PoolClient,
    callId: number,
    payload: BusinessResultPayloadDto,
  ) {
    return (
      await client.query<{
        questionSpeaker: string | null;
        answerSpeaker: string | null;
      }>(
        `SELECT
         (SELECT speaker FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$2) AS "questionSpeaker",
         (SELECT speaker FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$3) AS "answerSpeaker"`,
        [callId, payload.questionUtteranceOrder, payload.answerUtteranceOrder],
      )
    ).rows[0];
  }

  async findOrInsertUtterance(
    client: PoolClient,
    callId: number,
    payload: UtterancePayloadDto,
  ) {
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
      await client.query<{
        id: number;
        speaker: string;
        text: string;
        lastSentenceSeq: number;
      }>(
        `SELECT call_utterance_seq AS id,speaker,utterance_text AS text,last_sentence_seq AS "lastSentenceSeq"
       FROM call_utterances WHERE call_session_seq=$1 AND utterance_order=$2 FOR KEY SHARE`,
        [callId, payload.utteranceOrder],
      )
    ).rows[0];
  }

  async saveFaqQuestionExamples(
    client: PoolClient,
    callId: number,
    events: CallEventInputDto[],
  ): Promise<void> {
    const results = events.map((event) => {
      const payload = event.payload as BusinessResultPayloadDto;
      return {
        eventId: event.eventId,
        faqEntrySeqs: payload.faqEntrySeqs ?? [payload.faqEntrySeq!],
        questionUtteranceOrder: payload.questionUtteranceOrder!,
        occurredAt: event.occurredAt,
      };
    });
    const questions = await client.query<{
      utteranceOrder: number;
      text: string;
    }>(
      `SELECT utterance_order AS "utteranceOrder",utterance_text AS text FROM call_utterances
       WHERE call_session_seq=$1 AND utterance_order=ANY($2::int[]) ORDER BY utterance_order`,
      [
        callId,
        [...new Set(results.map((result) => result.questionUtteranceOrder))],
      ],
    );
    await this.audit.prepareFaqExamples(client, {
      questions: questions.rows,
      results,
    });
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
