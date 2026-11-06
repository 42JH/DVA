import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { readPage, type PageRows } from '../common/pagination-query';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type {
  CallActionDto,
  CallProcessingResultDto,
} from './dto/call-event-response.dto';

@Injectable()
export class CallEventsRepository {
  constructor(private readonly database: DatabaseService) {}

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
}
