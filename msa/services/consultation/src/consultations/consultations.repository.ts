import type { PoolClient } from 'pg';
import { readPage, type PageRows } from '../common/pagination-query';
import type { TranscriptQueryDto, UtteranceDto } from './dto/transcript.dto';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { CallQueryDto } from './dto/call-query.dto';
import type {
  CallDto,
  CallListItemDto,
  RecordingDto,
} from './dto/call-response.dto';
import type { CallAnalysisDto } from './dto/call-analysis-response.dto';
import {
  CallReadReferencesClient,
  type CallReferenceRequest,
  type CallReferences,
} from './call-read-references.client';

type Candidate = CallReferenceRequest & {
  callSessionSeq: number;
  startedAt: Date | null;
  startedAtCursor: string | null;
};
const candidateSelect = `SELECT c.call_session_seq AS "callSessionSeq",c.order_seq AS "orderSeq",c.customer_seq AS "customerSeq",
 a.ai_persona_version_seq AS "aiPersonaVersionSeq",COALESCE(c.started_at,a.ai_started_at,c.incoming_at) AS "startedAt",
 COALESCE(c.started_at,a.ai_started_at,c.incoming_at)::text AS "startedAtCursor"
 FROM call_sessions c LEFT JOIN call_analyses a ON a.call_session_seq=c.call_session_seq`;
const callOrder = '"startedAt" DESC NULLS LAST,"callSessionSeq" DESC';
const referenceCtes = `WITH order_references AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(order_seq integer,customer_seq integer,status text,total_amount integer)),
 customer_references AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(customer_seq integer,name text,organization_seq integer,organization_name text)),
 persona_references AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(ai_persona_version_seq integer,name text,version integer)) `;
const referenceValues = (references: CallReferences): unknown[] => [
  JSON.stringify(references.order),
  JSON.stringify(references.customer),
  JSON.stringify(references.persona),
];

function callFilters(
  query: CallQueryDto,
  foreign: boolean,
  values: unknown[] = [],
) {
  const conditions = [
    "c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')",
  ];
  for (const [value, column, operator, remote] of [
    [query.orderSeq, 'c.order_seq', '=', false],
    [query.organizationSeq, 'customer.organization_seq', '=', true],
    [query.orderStatus, 'o.status', '=', true],
    [query.callerPhoneNumber, 'c.caller_phone_number', '=', false],
    [query.from, CALL_STARTED_AT, '>=', false],
    [query.to, CALL_STARTED_AT, '<', false],
    [query.hasComplaint, 'a.has_complaint', '=', false],
    [query.aiPersonaVersionSeq, 'a.ai_persona_version_seq', '=', false],
  ] as const)
    if (value !== undefined && (foreign || !remote)) {
      values.push(value);
      conditions.push(`${column} ${operator} $${values.length}`);
    }
  if (foreign && query.q) {
    values.push(query.q);
    const parameter = `$${values.length}`;
    conditions.push(
      `(strpos(lower(normalize(customer.name,NFC)),lower(normalize(${parameter},NFC)))>0 OR strpos(c.caller_phone_number,${parameter})>0)`,
    );
  }
  return { where: 'WHERE ' + conditions.join(' AND '), values };
}
type RecordingRow = Pick<RecordingDto, 'recordingSeq' | 'createdAt'> & {
  objectKey: string;
};

type CallRow = CallDto & {
  aiPersonaVersionSeq: number | null;
  personaName: string | null;
  personaVersion: number | null;
  isNewCustomer: boolean | null;
  registeredParcelCount: number | null;
  faqAnswerCount: number | null;
  orderLookupCount: number | null;
  cancelledParcelCount: number | null;
  hasHandoffRequest: boolean | null;
  hasCallbackRequest: boolean | null;
  aiStartedAt: Date | null;
  aiEndedAt: Date | null;
  repeatQuestionCount: number | null;
  hasComplaint: boolean | null;
  complaints: CallAnalysisDto['complaints'] | null;
  analysedAt: Date | null;
};

const CALL_STARTED_AT = 'COALESCE(c.started_at,a.ai_started_at,c.incoming_at)';

const callSelect = (
  includeRecordedAt = true,
) => `SELECT c.call_session_seq AS "callSessionSeq",c.provider_call_id AS "providerCallId",
 CASE WHEN a.call_session_seq IS NOT NULL THEN 'COMPLETED'
  WHEN c.analysis_failed_at IS NOT NULL THEN 'FAILED'
  WHEN c.ended_at<=transaction_timestamp()-interval '10 minutes' THEN 'EXPIRED'
  ELSE 'PENDING' END AS "analysisStatus",
 ${includeRecordedAt ? '(SELECT min(r.created_at) FROM recordings r WHERE r.call_session_seq=c.call_session_seq) AS "recordedAt",' : ''}
 c.caller_phone_number AS "callerPhoneNumber",c.order_seq AS "orderSeq",o.status AS "orderStatus",o.total_amount AS "orderTotalAmount",
 ${CALL_STARTED_AT} AS "startedAt",COALESCE(c.ended_at,a.ai_ended_at) AS "endedAt",
 customer.customer_seq AS "customerSeq",customer.name AS "customerName",customer.organization_name AS "organizationName",
 a.ai_persona_version_seq AS "aiPersonaVersionSeq",v.name AS "personaName",v.version AS "personaVersion",
 a.ai_started_at AS "aiStartedAt",a.ai_ended_at AS "aiEndedAt",a.repeat_question_count AS "repeatQuestionCount",
 a.has_complaint AS "hasComplaint",a.complaints,a.analysed_at AS "analysedAt",
 a.is_new_customer AS "isNewCustomer",a.registered_parcel_count AS "registeredParcelCount",
 a.faq_answer_count AS "faqAnswerCount",a.order_lookup_count AS "orderLookupCount",
 a.cancelled_parcel_count AS "cancelledParcelCount",a.has_handoff_request AS "hasHandoffRequest",
 a.has_callback_request AS "hasCallbackRequest"
 FROM call_sessions c LEFT JOIN order_references o ON o.order_seq=c.order_seq
 LEFT JOIN customer_references customer ON customer.customer_seq=COALESCE(o.customer_seq,c.customer_seq)
 LEFT JOIN call_analyses a ON a.call_session_seq=c.call_session_seq
 LEFT JOIN persona_references v ON v.ai_persona_version_seq=a.ai_persona_version_seq`;

function callResult(row: CallRow): CallListItemDto {
  const {
    aiPersonaVersionSeq,
    personaName,
    personaVersion,
    isNewCustomer,
    registeredParcelCount,
    faqAnswerCount,
    orderLookupCount,
    cancelledParcelCount,
    hasHandoffRequest,
    hasCallbackRequest,
    aiStartedAt,
    aiEndedAt,
    repeatQuestionCount,
    hasComplaint,
    complaints,
    analysedAt,
    ...call
  } = row;
  return {
    ...call,
    analysis:
      analysedAt === null
        ? null
        : {
            aiPersonaVersionSeq,
            personaName,
            personaVersion,
            isNewCustomer,
            registeredParcelCount,
            faqAnswerCount,
            orderLookupCount,
            cancelledParcelCount,
            hasHandoffRequest,
            hasCallbackRequest,
            aiStartedAt: aiStartedAt!,
            aiEndedAt: aiEndedAt!,
            repeatQuestionCount,
            hasComplaint,
            complaints: complaints!,
            analysedAt,
          },
  };
}

@Injectable()
export class ConsultationsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly references: CallReadReferencesClient,
  ) {}

  private async project(
    client: PoolClient,
    ids: number[],
    references: CallReferences,
  ): Promise<CallListItemDto[]> {
    if (!ids.length) return [];
    const result = await client.query<CallRow>(
      `${referenceCtes}${callSelect()} WHERE c.call_session_seq=ANY($4::int[]) ORDER BY ${callOrder}`,
      [...referenceValues(references), ids],
    );
    return result.rows.map(callResult);
  }

  async findOne(id: number): Promise<CallListItemDto | undefined> {
    return this.database.readOnly(async (client) => {
      const candidates = await client.query<Candidate>(
        `${candidateSelect} WHERE c.call_session_seq=$1 AND c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')`,
        [id],
      );
      if (!candidates.rows.length) return undefined;
      return (
        await this.project(
          client,
          [id],
          await this.references.load(candidates.rows),
        )
      )[0];
    });
  }

  async findMany(
    query: CallQueryDto,
    client?: PoolClient,
  ): Promise<PageRows<CallListItemDto>> {
    if (!client)
      return this.database.readOnly((reader) => this.findMany(query, reader));
    const local = callFilters(query, false);
    if (
      !query.q &&
      query.organizationSeq === undefined &&
      query.orderStatus === undefined
    ) {
      const page = await readPage<Candidate>(
        client,
        `${candidateSelect} ${local.where}`,
        local.values,
        query,
        callOrder,
      );
      return {
        rows: await this.project(
          client,
          page.rows.map((row) => row.callSessionSeq),
          await this.references.load(page.rows),
        ),
        total_count: page.total_count,
      };
    }
    const rows: CallListItemDto[] = [];
    let total_count = 0,
      cursor: Candidate | undefined;
    for (;;) {
      const values = [...local.values];
      let after = '';
      if (cursor) {
        values.push(cursor.startedAtCursor, cursor.callSessionSeq);
        const time = `$${values.length - 1}::timestamptz`,
          id = `$${values.length}::integer`;
        after = ` AND ((${time} IS NOT NULL AND (${CALL_STARTED_AT}<${time} OR ${CALL_STARTED_AT} IS NULL OR (${CALL_STARTED_AT}=${time} AND c.call_session_seq<${id}))) OR (${time} IS NULL AND ${CALL_STARTED_AT} IS NULL AND c.call_session_seq<${id}))`;
      }
      const candidates = await client.query<Candidate>(
        `${candidateSelect} ${local.where}${after} ORDER BY ${callOrder} LIMIT 251`,
        values,
      );
      const batch = candidates.rows.slice(0, 250);
      if (!batch.length) break;
      const references = await this.references.load(batch),
        filters = callFilters(query, true, referenceValues(references));
      filters.values.push(batch.map((row) => row.callSessionSeq));
      const matching = await client.query<{ callSessionSeq: number }>(
        `${referenceCtes} SELECT "callSessionSeq" FROM (${callSelect(false)} ${filters.where} AND c.call_session_seq=ANY($${filters.values.length}::int[])) matching ORDER BY ${callOrder}`,
        filters.values,
      );
      const from = Math.max(0, query.offset - total_count),
        remaining = query.limit + 1 - rows.length;
      if (remaining > 0)
        rows.push(
          ...(await this.project(
            client,
            matching.rows
              .slice(from, from + remaining)
              .map((row) => row.callSessionSeq),
            references,
          )),
        );
      total_count += matching.rows.length;
      if (candidates.rows.length <= 250) break;
      cursor = batch[batch.length - 1];
    }
    return { rows, total_count };
  }

  async findRecordings(id: number): Promise<RecordingRow[]> {
    return (
      await this.database.pool.query<RecordingRow>(
        `SELECT recording_seq AS "recordingSeq",created_at AS "createdAt",object_key AS "objectKey"
       FROM recordings WHERE call_session_seq=$1 AND EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_session_seq=$1
        AND c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')) ORDER BY recording_seq`,
        [id],
      )
    ).rows;
  }

  async countActions(id: number): Promise<number> {
    return (
      await this.database.pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM call_insight_events WHERE call_session_seq=$1 AND kind='AI_ACTION'",
        [id],
      )
    ).rows[0].count;
  }
  async activeCount() {
    const row = (
      await this.database.pool.query<{
        activeCallCount: number;
        observedAt: Date;
      }>(
        `SELECT count(*)::int AS "activeCallCount",statement_timestamp() AS "observedAt"
       FROM call_sessions c WHERE c.registered_at IS NOT NULL AND c.ended_at IS NULL AND c.deleted_at IS NULL
        AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')
        AND NOT EXISTS(SELECT 1 FROM call_analyses a
          WHERE a.call_session_seq=c.call_session_seq AND a.ai_ended_at IS NOT NULL)`,
      )
    ).rows[0];
    return {
      activeCallCount: row.activeCallCount,
      observedAt: row.observedAt.toISOString(),
    };
  }

  async lockForDeletion(client: PoolClient, id: number) {
    return (
      await client.query<{
        endedAt: Date | null;
        orderFinalizedAt: Date | null;
      }>(
        `SELECT ended_at AS "endedAt",order_finalized_at AS "orderFinalizedAt" FROM call_sessions
      WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR UPDATE`,
        [id],
      )
    ).rows[0];
  }

  async recordingInProgress(client: PoolClient, id: number): Promise<boolean> {
    return !!(
      await client.query(
        `SELECT 1 FROM pbx_webhooks.call_ended_events
      WHERE call_session_seq=$1 AND (processing_status<>'PROCESSED' OR claimed_until>clock_timestamp()) LIMIT 1`,
        [id],
      )
    ).rowCount;
  }

  async softDelete(client: PoolClient, id: number): Promise<void> {
    await client.query(
      'UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE call_session_seq=$1',
      [id],
    );
    await client.query("SELECT pg_notify('call_sessions_changed','')");
  }

  async findTranscript(
    id: number,
    query: TranscriptQueryDto,
  ): Promise<PageRows<UtteranceDto>> {
    return await readPage<UtteranceDto>(
      this.database.pool,
      `SELECT u.call_utterance_seq AS "callUtteranceSeq",u.utterance_order AS "utteranceOrder",u.speaker,
       u.utterance_text AS "utteranceText",u.last_sentence_seq AS "lastSentenceSeq",u.received_at AS "receivedAt",
       e.offset_seconds::double precision AS "offsetSeconds"
       FROM call_utterances u LEFT JOIN call_insight_events e ON e.call_utterance_seq=u.call_utterance_seq
        AND e.call_session_seq=u.call_session_seq AND e.kind='UTTERANCE'
       WHERE u.call_session_seq=$1`,
      [id],
      query,
      '"utteranceOrder","callUtteranceSeq"',
    );
  }

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
}
