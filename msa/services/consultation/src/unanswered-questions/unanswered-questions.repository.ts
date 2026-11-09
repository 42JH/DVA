import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';

@Injectable()
export class UnansweredQuestionsRepository {
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

  async delete(client: PoolClient, id: number): Promise<void> {
    await client.query(
      `UPDATE unanswered_questions SET status='DELETED',deleted_at=clock_timestamp()
       WHERE unanswered_question_seq=$1`,
      [id],
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
