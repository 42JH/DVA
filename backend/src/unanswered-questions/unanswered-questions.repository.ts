import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';

@Injectable()
export class UnansweredQuestionsRepository {
  async findCall(client: PoolClient, id: number): Promise<string | undefined> {
    return (
      await client.query<{ providerCallId: string }>(
        'SELECT provider_call_id AS "providerCallId" FROM call_sessions WHERE call_session_seq=$1 FOR KEY SHARE',
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
        `INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,offset_seconds,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING RETURNING unanswered_question_seq AS id`,
        [
          input.eventId,
          input.callSessionSeq,
          input.questionText,
          input.occurredAt,
          input.offsetSeconds,
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
