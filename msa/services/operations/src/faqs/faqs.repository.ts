import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminFaqQueryDto, AiFaqQueryDto, CreateFaqDto, UpdateFaqDto } from './dto/faq-request.dto';
import { AgentFaqDto, FaqDetailDto, FaqQuestionExampleDto, FaqDto } from './dto/faq-response.dto';

const AGENT_FIELDS = 'faq_entry_seq AS "faqEntrySeq",question,answer,updated_at AS "updatedAt"';
const ADMIN_FIELDS = `${AGENT_FIELDS},category,created_at AS "createdAt",updated_by_admin_user_seq AS "updatedByAdminUserSeq"`;

export type StoredFaqDetail = Omit<FaqDetailDto, 'recentQuestions'> & {
  recentQuestions: Array<Omit<FaqQuestionExampleDto, 'callSessionSeq'> & { eventId: string }>;
};

@Injectable()
export class FaqsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(
    query: AiFaqQueryDto | AdminFaqQueryDto,
    agent: boolean,
  ): Promise<PageRows<AgentFaqDto | FaqDto>> {
    // 조회 열은 두 고정값만 사용하며 AI 응답에서는 관리자 정보를 DB에서 가져오지 않는다.
    return await readPage<AgentFaqDto | FaqDto>(
      this.database.pool,
      `SELECT ${agent ? AGENT_FIELDS : ADMIN_FIELDS} FROM faq_entries
       WHERE deleted_at IS NULL AND ($1::text IS NULL OR strpos(lower(normalize(question,NFC)),lower(normalize($1,NFC)))>0
         OR strpos(lower(normalize(answer,NFC)),lower(normalize($1,NFC)))>0)
         AND ($2::int[] IS NULL OR faq_entry_seq=ANY($2::int[]))
         AND ($3::text IS NULL OR category=$3)`,
      [
        query.q || null,
        'faqEntrySeqs' in query ? (query.faqEntrySeqs ?? null) : null,
        !agent && 'category' in query ? (query.category ?? null) : null,
      ],
      query,
      '"faqEntrySeq"',
    );
  }

  async find(client: PoolClient, id: number): Promise<StoredFaqDetail | undefined> {
    const locked = await client.query(
      'SELECT 1 FROM faq_entries WHERE faq_entry_seq=$1 AND deleted_at IS NULL FOR SHARE',
      [id],
    );
    if (!locked.rowCount) return undefined;
    return (
      await client.query<StoredFaqDetail>(
        `SELECT ${ADMIN_FIELDS},COALESCE((
           SELECT jsonb_agg(jsonb_build_object('faqQuestionExampleSeq',e.faq_question_example_seq,
             'questionText',e.question_text,'occurredAt',e.occurred_at,'eventId',e.event_id)
             ORDER BY e.occurred_at DESC,e.faq_question_example_seq DESC)
           FROM (SELECT faq_question_example_seq,event_id,question_text,occurred_at FROM faq_question_examples
             WHERE faq_entry_seq=f.faq_entry_seq AND occurred_at>statement_timestamp()-interval '5 years'
             ORDER BY occurred_at DESC,faq_question_example_seq DESC LIMIT 10) e
         ),'[]'::jsonb) AS "recentQuestions"
         FROM faq_entries f WHERE faq_entry_seq=$1 AND deleted_at IS NULL`,
        [id],
      )
    ).rows[0];
  }

  async insert(client: PoolClient, input: CreateFaqDto, adminId: number): Promise<number> {
    return (
      await client.query<{ id: number }>(
        'INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,category) VALUES($1,$2,$3,$4) RETURNING faq_entry_seq AS id',
        [input.question, input.answer, adminId, input.category],
      )
    ).rows[0].id;
  }

  async update(
    client: PoolClient,
    id: number,
    input: UpdateFaqDto,
    adminId: number,
  ): Promise<boolean> {
    return (
      (
        await client.query(
          `UPDATE faq_entries SET question=$2,answer=$3,category=$5,
       updated_by_admin_user_seq=$4 WHERE faq_entry_seq=$1 AND deleted_at IS NULL`,
          [id, input.question, input.answer, adminId, input.category],
        )
      ).rowCount === 1
    );
  }

  async delete(client: PoolClient, ids: number[]): Promise<number[]> {
    return (
      await client.query<{ id: number }>(
        `WITH targets AS (
           SELECT faq_entry_seq FROM faq_entries WHERE faq_entry_seq=ANY($1::int[]) AND deleted_at IS NULL
           ORDER BY faq_entry_seq FOR UPDATE
         ) UPDATE faq_entries SET deleted_at=clock_timestamp()
         WHERE faq_entry_seq IN (SELECT faq_entry_seq FROM targets) AND deleted_at IS NULL
         RETURNING faq_entry_seq AS id`,
        [ids],
      )
    ).rows.map((row) => row.id);
  }
}
