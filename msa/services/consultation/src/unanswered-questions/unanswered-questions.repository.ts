import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';
import { DatabaseService } from '../database/database.service';
import { readPage, type PageRows } from '../common/pagination-query';
import {
  CallReadReferencesClient,
  type CallReferenceRequest,
} from '../consultations/call-read-references.client';
import type { UnansweredQuestionDto } from './dto/unanswered-question-list-response.dto';
import type { UnansweredQuestionQueryDto } from './dto/unanswered-question-query.dto';
import { retryFaqWrite } from '@dva/events/faq-conversion.cjs';
import { ensureFaqConversionsConfirmed } from './faq-conversion';

type Candidate = CallReferenceRequest & {
  unansweredQuestionSeq: number;
  faqEntrySeq: number | null;
  callStartedAt: Date | null;
  startedAtCursor: string | null;
};
const startedAt = 'COALESCE(c.started_at,a.ai_started_at)';
const orderBy = '"callStartedAt" ASC NULLS LAST,"unansweredQuestionSeq" ASC';
const tables = `FROM unanswered_questions u JOIN call_sessions c ON c.call_session_seq=u.call_session_seq
 LEFT JOIN call_analyses a ON a.call_session_seq=c.call_session_seq`;
const candidates = `SELECT u.unanswered_question_seq AS "unansweredQuestionSeq",u.faq_entry_seq AS "faqEntrySeq",
 c.order_seq AS "orderSeq",c.customer_seq AS "customerSeq",NULL::integer AS "aiPersonaVersionSeq",
 ${startedAt} AS "callStartedAt",${startedAt}::text AS "startedAtCursor" ${tables}`;
const referencesSql = `WITH order_references AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(order_seq integer,customer_seq integer)),
 customer_references AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(customer_seq integer,name text)),
 faq_references AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(faq_entry_seq integer)) `;
const projection = `SELECT u.unanswered_question_seq AS "unansweredQuestionSeq",u.call_session_seq AS "callSessionSeq",
 ${startedAt} AS "callStartedAt",u.occurred_at AS "occurredAt",u.offset_seconds::double precision AS "offsetSeconds",
 customer.customer_seq AS "customerSeq",customer.name AS "customerName",c.caller_phone_number AS "callerPhoneNumber",
 u.question_text AS "questionText",u.status,u.reason,a.ai_persona_version_seq AS "aiPersonaVersionSeq",f.faq_entry_seq AS "faqEntrySeq"
 ${tables} LEFT JOIN order_references o ON o.order_seq=c.order_seq
 LEFT JOIN customer_references customer ON customer.customer_seq=COALESCE(o.customer_seq,c.customer_seq)
 LEFT JOIN faq_references f ON f.faq_entry_seq=u.faq_entry_seq`;
function filters(
  query: UnansweredQuestionQueryDto,
  foreign = false,
  values: unknown[] = [],
) {
  const conditions = [
    "u.status IN ('OPEN','REGISTERED') AND c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')",
  ];
  if (query.status !== 'ALL') {
    values.push(query.status);
    conditions.push(`u.status=$${values.length}`);
  }
  for (const [value, column, operator] of [
    [query.unansweredQuestionSeq, 'u.unanswered_question_seq', '='],
    [query.callSessionSeq, 'u.call_session_seq', '='],
    [query.aiPersonaVersionSeq, 'a.ai_persona_version_seq', '='],
    [query.from, startedAt, '>='],
    [query.to, startedAt, '<'],
  ] as const)
    if (value !== undefined) {
      values.push(value);
      conditions.push(`${column}${operator}$${values.length}`);
    }
  if (query.reason !== undefined) {
    values.push(query.reason);
    conditions.push(
      `(u.reason=$${values.length} OR ($${values.length}='UNCLASSIFIED' AND u.reason IS NULL))`,
    );
  }
  if (foreign && query.q) {
    values.push(query.q);
    const p = `$${values.length}`;
    conditions.push(
      `(strpos(lower(normalize(u.question_text,NFC)),lower(normalize(${p},NFC)))>0 OR strpos(lower(normalize(customer.name,NFC)),lower(normalize(${p},NFC)))>0 OR strpos(c.caller_phone_number,${p})>0)`,
    );
  }
  return { where: 'WHERE ' + conditions.join(' AND '), values };
}

@Injectable()
export class UnansweredQuestionsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly references: CallReadReferencesClient,
  ) {}

  private async project(
    client: PoolClient,
    batch: Candidate[],
    query?: UnansweredQuestionQueryDto,
  ): Promise<UnansweredQuestionDto[]> {
    if (!batch.length) return [];
    const [refs, faqs] = await Promise.all([
      this.references.load(batch),
      this.references.read(
        'faq',
        batch.map((row) => row.faqEntrySeq),
      ),
    ]);
    const values: unknown[] = [
      JSON.stringify(refs.order),
      JSON.stringify(refs.customer),
      JSON.stringify(faqs),
    ];
    const filter = query
      ? filters(query, true, values)
      : { where: 'WHERE true', values };
    filter.values.push(batch.map((row) => row.unansweredQuestionSeq));
    return (
      await client.query<UnansweredQuestionDto>(
        `${referencesSql}${projection} ${filter.where} AND u.unanswered_question_seq=ANY($${filter.values.length}::int[]) ORDER BY ${orderBy}`,
        filter.values,
      )
    ).rows;
  }

  async findMany(
    query: UnansweredQuestionQueryDto,
    client?: PoolClient,
  ): Promise<PageRows<UnansweredQuestionDto>> {
    if (!client)
      return retryFaqWrite(() =>
        this.database.readOnly((reader) => this.findMany(query, reader)),
      );
    await ensureFaqConversionsConfirmed(client);
    const local = filters(query);
    if (!query.q) {
      const page = await readPage<Candidate>(
        client,
        `${candidates} ${local.where}`,
        local.values,
        query,
        orderBy,
      );
      return {
        rows: await this.project(client, page.rows),
        total_count: page.total_count,
      };
    }
    const rows: UnansweredQuestionDto[] = [];
    let total_count = 0,
      cursor: Candidate | undefined;
    for (;;) {
      const values = [...local.values];
      let after = '';
      if (cursor) {
        values.push(cursor.startedAtCursor, cursor.unansweredQuestionSeq);
        const time = `$${values.length - 1}::timestamptz`,
          id = `$${values.length}::integer`;
        after = ` AND ((${time} IS NOT NULL AND (${startedAt}>${time} OR ${startedAt} IS NULL OR (${startedAt}=${time} AND u.unanswered_question_seq>${id}))) OR (${time} IS NULL AND ${startedAt} IS NULL AND u.unanswered_question_seq>${id}))`;
      }
      const next = await client.query<Candidate>(
        `${candidates} ${local.where}${after} ORDER BY ${orderBy} LIMIT 251`,
        values,
      );
      const batch = next.rows.slice(0, 250);
      if (!batch.length) break;
      const matching = await this.project(client, batch, query);
      const from = Math.max(0, query.offset - total_count),
        remaining = query.limit + 1 - rows.length;
      if (remaining > 0) rows.push(...matching.slice(from, from + remaining));
      total_count += matching.length;
      if (next.rows.length <= 250) break;
      cursor = batch[batch.length - 1];
    }
    return { rows, total_count };
  }

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

  async faqExists(id: number): Promise<boolean> {
    return (await this.references.read('faq', [id])).length === 1;
  }

  async register(
    client: PoolClient,
    id: number,
    faqId: number,
    hash: string,
  ): Promise<void> {
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
