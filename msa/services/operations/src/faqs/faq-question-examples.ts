import type { PoolClient } from 'pg';
import {
  validateFaqExamples,
  type FaqExamplesPayload,
} from '@dva/events/faq-question-examples.cjs';

type ReservedExample = {
  faq_question_example_seq: number;
  faq_entry_seq: number;
  event_id: string;
  occurred_at: string;
  question_utterance_order: number;
  faq_updated_at: string;
};
type Preparation = { _faqExamples: FaqExamplesPayload & { rows: ReservedExample[] } };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isFaqExamplesPreparation = (value: unknown): value is Preparation =>
  object(value) && Object.hasOwn(value, '_faqExamples');

async function prune(client: PoolClient, ids: number[]): Promise<void> {
  await client.query(
    `DELETE FROM faq_question_examples WHERE faq_entry_seq=ANY($1::int[])
     AND (occurred_at<=statement_timestamp()-interval '5 years' OR faq_question_example_seq IN (
       SELECT faq_question_example_seq FROM (
         SELECT faq_question_example_seq,row_number() OVER(PARTITION BY faq_entry_seq
           ORDER BY occurred_at DESC,faq_question_example_seq DESC) AS position
         FROM faq_question_examples WHERE faq_entry_seq=ANY($1::int[])
       ) ranked WHERE position>10))`,
    [ids],
  );
}

export async function prepareFaqExamples(
  client: PoolClient,
  input: FaqExamplesPayload,
): Promise<Preparation> {
  const results = input.results.flatMap((result) =>
    result.faqEntrySeqs.map((id) => ({
      event_id: result.eventId,
      faq_entry_seq: id,
      question_utterance_order: result.questionUtteranceOrder,
      occurred_at: result.occurredAt,
    })),
  );
  const ids = [...new Set(results.map((row) => row.faq_entry_seq))];
  await client.query('SAVEPOINT faq_examples_preparation');
  try {
    const inserted = await client.query<{ faq_question_example_seq: number }>(
      `WITH current_faqs AS (
         SELECT faq_entry_seq,updated_at FROM faq_entries
         WHERE faq_entry_seq=ANY($3::int[]) AND deleted_at IS NULL
         ORDER BY faq_entry_seq FOR UPDATE
       ) INSERT INTO faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
       SELECT f.faq_entry_seq,r.event_id,u.text,r.occurred_at
       FROM jsonb_to_recordset($2::jsonb) AS r(event_id uuid,faq_entry_seq integer,
         question_utterance_order integer,occurred_at timestamptz)
       JOIN current_faqs f ON f.faq_entry_seq=r.faq_entry_seq
       JOIN jsonb_to_recordset($1::jsonb) AS u("utteranceOrder" integer,text text)
         ON u."utteranceOrder"=r.question_utterance_order
       WHERE r.occurred_at>=f.updated_at
         AND r.occurred_at>statement_timestamp()-interval '5 years'
       ORDER BY r.occurred_at,r.event_id
       ON CONFLICT(faq_entry_seq,event_id) DO NOTHING RETURNING faq_question_example_seq`,
      [JSON.stringify(input.questions), JSON.stringify(results), ids],
    );
    const reserved = await client.query<ReservedExample>(
      `SELECT e.faq_question_example_seq,e.faq_entry_seq,e.event_id,e.occurred_at::text,
        r.question_utterance_order,f.updated_at::text AS faq_updated_at
       FROM faq_question_examples e JOIN faq_entries f USING(faq_entry_seq)
       JOIN jsonb_to_recordset($2::jsonb) AS r(event_id uuid,faq_entry_seq integer,question_utterance_order integer)
         ON r.event_id=e.event_id AND r.faq_entry_seq=e.faq_entry_seq
       WHERE e.faq_question_example_seq=ANY($1::int[]) ORDER BY e.faq_question_example_seq`,
      [inserted.rows.map((row) => row.faq_question_example_seq), JSON.stringify(results)],
    );
    await prune(client, ids);
    // Reserve the original identity values and validate DB writes without exposing uncommitted examples.
    await client.query('ROLLBACK TO SAVEPOINT faq_examples_preparation');
    return { _faqExamples: { ...input, rows: reserved.rows } };
  } catch (error: unknown) {
    await client.query('ROLLBACK TO SAVEPOINT faq_examples_preparation');
    throw error;
  } finally {
    await client.query('RELEASE SAVEPOINT faq_examples_preparation');
  }
}

export async function commitFaqExamples(
  client: PoolClient,
  prepared: Preparation,
  transactionId: string,
): Promise<void> {
  const input = prepared._faqExamples;
  validateFaqExamples({
    transactionId: input.transactionId,
    questions: input.questions,
    results: input.results,
  });
  if (input.transactionId !== transactionId || !Array.isArray(input.rows))
    throw new Error('Invalid FAQ examples preparation');
  const ids = [...new Set(input.results.flatMap((result) => result.faqEntrySeqs))];
  await client.query(
    'SELECT faq_entry_seq FROM faq_entries WHERE faq_entry_seq=ANY($1::int[]) ORDER BY faq_entry_seq FOR UPDATE',
    [ids],
  );
  await client.query(
    `INSERT INTO faq_question_examples(faq_question_example_seq,faq_entry_seq,event_id,question_text,occurred_at)
     OVERRIDING SYSTEM VALUE
     SELECT r.faq_question_example_seq,r.faq_entry_seq,r.event_id,q.text,r.occurred_at
     FROM jsonb_to_recordset($1::jsonb) AS r(faq_question_example_seq integer,faq_entry_seq integer,
       event_id uuid,occurred_at timestamptz,question_utterance_order integer,faq_updated_at timestamptz)
     JOIN jsonb_to_recordset($2::jsonb) AS q("utteranceOrder" integer,text text)
       ON q."utteranceOrder"=r.question_utterance_order
     JOIN faq_entries f ON f.faq_entry_seq=r.faq_entry_seq AND f.deleted_at IS NULL AND f.updated_at=r.faq_updated_at
     ORDER BY r.faq_question_example_seq ON CONFLICT(faq_entry_seq,event_id) DO NOTHING`,
    [JSON.stringify(input.rows), JSON.stringify(input.questions)],
  );
  await prune(client, ids);
}
