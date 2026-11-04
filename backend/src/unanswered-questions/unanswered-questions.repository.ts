import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';
import { UnansweredQuestionDto } from './dto/unanswered-question-list-response.dto';
import { UnansweredQuestionQueryDto } from './dto/unanswered-question-query.dto';

@Injectable()
export class UnansweredQuestionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findForUpdate(client: PoolClient, id: number) {
    return (
      await client.query<{
        status: 'OPEN' | 'REGISTERED' | 'DELETED';
        faqId: number | null;
        conversionHash: string | null;
      }>(
        `SELECT status,faq_entry_seq AS "faqId",faq_conversion_hash AS "conversionHash"
       FROM unanswered_questions WHERE unanswered_question_seq=$1
       AND EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_session_seq=unanswered_questions.call_session_seq
        AND c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years') FOR SHARE)
       FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }

  async faqExists(client: PoolClient, id: number): Promise<boolean> {
    return (
      (
        await client.query(
          'SELECT 1 FROM faq_entries WHERE faq_entry_seq=$1 AND deleted_at IS NULL FOR SHARE',
          [id],
        )
      ).rowCount === 1
    );
  }

  async register(client: PoolClient, id: number, faqId: number, hash: string): Promise<void> {
    await client.query(
      `UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=$2,
       faq_conversion_hash=$3,registered_at=clock_timestamp() WHERE unanswered_question_seq=$1`,
      [id, faqId, hash],
    );
  }

  async delete(client: PoolClient, id: number): Promise<void> {
    await client.query(
      `UPDATE unanswered_questions SET status='DELETED',deleted_at=clock_timestamp()
       WHERE unanswered_question_seq=$1`,
      [id],
    );
  }

  async findMany(query: UnansweredQuestionQueryDto): Promise<PageRows<UnansweredQuestionDto>> {
    return await readPage<UnansweredQuestionDto>(
      this.database.pool,
      `SELECT u.unanswered_question_seq AS "unansweredQuestionSeq",u.call_session_seq AS "callSessionSeq",
         COALESCE(c.started_at,a.ai_started_at) AS "callStartedAt",u.occurred_at AS "occurredAt",
         u.offset_seconds::double precision AS "offsetSeconds",customer.customer_seq AS "customerSeq",
         customer.name AS "customerName",c.caller_phone_number AS "callerPhoneNumber",u.question_text AS "questionText",
         u.status,u.reason,a.ai_persona_version_seq AS "aiPersonaVersionSeq",f.faq_entry_seq AS "faqEntrySeq"
         FROM unanswered_questions u JOIN call_sessions c ON c.call_session_seq=u.call_session_seq
         LEFT JOIN call_analyses a ON a.call_session_seq=c.call_session_seq
         LEFT JOIN orders o ON o.order_seq=c.order_seq AND o.deleted_at IS NULL
         LEFT JOIN customers customer ON customer.customer_seq=COALESCE(o.customer_seq,c.customer_seq) AND customer.deleted_at IS NULL
         LEFT JOIN faq_entries f ON f.faq_entry_seq=u.faq_entry_seq AND f.deleted_at IS NULL
         WHERE u.status IN ('OPEN','REGISTERED') AND ($1::text='ALL' OR u.status=$1) AND c.deleted_at IS NULL
           AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')
           AND ($2::integer IS NULL OR u.unanswered_question_seq=$2)
           AND ($3::integer IS NULL OR u.call_session_seq=$3)
           AND ($4::integer IS NULL OR a.ai_persona_version_seq=$4)
           AND ($5::text IS NULL OR strpos(lower(normalize(u.question_text,NFC)),lower(normalize($5,NFC)))>0
             OR strpos(lower(normalize(customer.name,NFC)),lower(normalize($5,NFC)))>0
             OR strpos(c.caller_phone_number,$5)>0)
           AND ($6::timestamptz IS NULL OR COALESCE(c.started_at,a.ai_started_at)>=$6)
           AND ($7::timestamptz IS NULL OR COALESCE(c.started_at,a.ai_started_at)<$7)
           AND ($8::text IS NULL OR u.reason=$8 OR ($8='UNCLASSIFIED' AND u.reason IS NULL))`,
      [
        query.status,
        query.unansweredQuestionSeq ?? null,
        query.callSessionSeq ?? null,
        query.aiPersonaVersionSeq ?? null,
        query.q || null,
        query.from ?? null,
        query.to ?? null,
        query.reason ?? null,
      ],
      query,
      '"callStartedAt" ASC NULLS LAST,"unansweredQuestionSeq" ASC',
    );
  }

  async findCall(client: PoolClient, id: number): Promise<string | undefined> {
    return (
      await client.query<{ providerCallId: string }>(
        'SELECT provider_call_id AS "providerCallId" FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval \'5 years\') FOR SHARE',
        [id],
      )
    ).rows[0]?.providerCallId;
  }

  async insert(
    client: PoolClient,
    input: CreateUnansweredQuestionDto,
    hash: string,
  ): Promise<number | undefined> {
    return (
      await client.query<{ id: number }>(
        `INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,offset_seconds,reason,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_id) DO NOTHING RETURNING unanswered_question_seq AS id`,
        [
          input.eventId,
          input.callSessionSeq,
          input.questionText,
          input.occurredAt,
          input.offsetSeconds,
          input.reason ?? null,
          hash,
        ],
      )
    ).rows[0]?.id;
  }

  async findExisting(client: PoolClient, eventId: string) {
    return (
      await client.query<{ id: number; callSessionSeq: number; hash: string }>(
        `SELECT unanswered_question_seq AS id,call_session_seq AS "callSessionSeq",payload_hash AS hash
         FROM unanswered_questions WHERE event_id=$1 FOR KEY SHARE`,
        [eventId],
      )
    ).rows[0];
  }
}
