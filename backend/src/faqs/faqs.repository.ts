import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminFaqQueryDto, AiFaqQueryDto, CreateFaqDto, UpdateFaqDto } from './dto/faq-request.dto';
import { AgentFaqDto, FaqDto } from './dto/faq-response.dto';

const AGENT_FIELDS = 'faq_entry_seq AS "faqEntrySeq",question,answer,updated_at AS "updatedAt"';
const ADMIN_FIELDS = `${AGENT_FIELDS},category,created_at AS "createdAt",updated_by_admin_user_seq AS "updatedByAdminUserSeq"`;

@Injectable()
export class FaqsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(
    query: AiFaqQueryDto | AdminFaqQueryDto,
    agent: boolean,
  ): Promise<Array<AgentFaqDto | FaqDto>> {
    // 조회 열은 두 고정값만 사용하며 AI 응답에서는 관리자 정보를 DB에서 가져오지 않는다.
    return (
      await this.database.pool.query<AgentFaqDto | FaqDto>(
        `SELECT ${agent ? AGENT_FIELDS : ADMIN_FIELDS} FROM faq_entries
       WHERE ($1::text IS NULL OR strpos(lower(normalize(question,NFC)),lower(normalize($1,NFC)))>0
         OR strpos(lower(normalize(answer,NFC)),lower(normalize($1,NFC)))>0)
         AND ($4::int[] IS NULL OR faq_entry_seq=ANY($4::int[]))
         AND ($5::text IS NULL OR category=$5)
       ORDER BY faq_entry_seq LIMIT $2 OFFSET $3`,
        [
          query.q || null,
          query.limit + 1,
          query.offset,
          'faqEntrySeqs' in query ? (query.faqEntrySeqs ?? null) : null,
          !agent && 'category' in query ? (query.category ?? null) : null,
        ],
      )
    ).rows;
  }

  async find(id: number, agent: boolean): Promise<AgentFaqDto | FaqDto | undefined> {
    return (
      await this.database.pool.query<AgentFaqDto | FaqDto>(
        `SELECT ${agent ? AGENT_FIELDS : ADMIN_FIELDS} FROM faq_entries WHERE faq_entry_seq=$1`,
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
       updated_by_admin_user_seq=$4 WHERE faq_entry_seq=$1`,
          [id, input.question, input.answer, adminId, input.category],
        )
      ).rowCount === 1
    );
  }

  async delete(client: PoolClient, ids: number[]): Promise<number[]> {
    return (
      await client.query<{ id: number }>(
        'DELETE FROM faq_entries WHERE faq_entry_seq=ANY($1::int[]) RETURNING faq_entry_seq AS id',
        [ids],
      )
    ).rows.map((row) => row.id);
  }
}
