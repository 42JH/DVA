import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDto, CallListItemDto, RecordingDto } from './dto/call-response.dto';
import { CallAnalysisDto } from './dto/call-analysis-response.dto';
import { TranscriptQueryDto, UtteranceDto } from './dto/transcript.dto';
import { PoolClient } from 'pg';

type RecordingRow = Pick<RecordingDto, 'recordingSeq' | 'createdAt'> & { objectKey: string };

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

const CALL_SELECT = `SELECT c.call_session_seq AS "callSessionSeq",c.provider_call_id AS "providerCallId",
 CASE WHEN a.call_session_seq IS NOT NULL THEN 'COMPLETED'
  WHEN c.analysis_failed_at IS NOT NULL THEN 'FAILED' ELSE 'PENDING' END AS "analysisStatus",
 (SELECT min(r.created_at) FROM recordings r WHERE r.call_session_seq=c.call_session_seq) AS "recordedAt",
 c.caller_phone_number AS "callerPhoneNumber",c.order_seq AS "orderSeq",o.status AS "orderStatus",o.total_amount AS "orderTotalAmount",
 ${CALL_STARTED_AT} AS "startedAt",COALESCE(c.ended_at,a.ai_ended_at) AS "endedAt",
 customer.customer_seq AS "customerSeq",customer.name AS "customerName",
 a.ai_persona_version_seq AS "aiPersonaVersionSeq",v.name AS "personaName",v.version AS "personaVersion",
 a.ai_started_at AS "aiStartedAt",a.ai_ended_at AS "aiEndedAt",a.repeat_question_count AS "repeatQuestionCount",
 a.has_complaint AS "hasComplaint",a.complaints,a.analysed_at AS "analysedAt",
 a.is_new_customer AS "isNewCustomer",a.registered_parcel_count AS "registeredParcelCount",
 a.faq_answer_count AS "faqAnswerCount",a.order_lookup_count AS "orderLookupCount",
 a.cancelled_parcel_count AS "cancelledParcelCount",a.has_handoff_request AS "hasHandoffRequest",
 a.has_callback_request AS "hasCallbackRequest"
 FROM call_sessions c LEFT JOIN orders o ON o.order_seq=c.order_seq AND o.deleted_at IS NULL
 LEFT JOIN customers customer ON customer.customer_seq=COALESCE(o.customer_seq,c.customer_seq) AND customer.deleted_at IS NULL
 LEFT JOIN call_analyses a ON a.call_session_seq=c.call_session_seq
 LEFT JOIN ai_persona_versions v ON v.ai_persona_version_seq=a.ai_persona_version_seq`;

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
  async lockForDeletion(client: PoolClient, id: number) {
    return (
      await client.query<{ endedAt: Date | null }>(
        `SELECT ended_at AS "endedAt" FROM call_sessions
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

  async orderIntakeInProgress(client: PoolClient, id: number): Promise<boolean> {
    return !!(
      await client.query(
        `SELECT 1 FROM call_sessions c WHERE c.call_session_seq=$1 AND c.order_finalized_at IS NULL
      AND EXISTS(SELECT 1 FROM order_parcel_drafts d WHERE d.call_session_seq=c.call_session_seq
       AND d.deleted_at IS NULL AND d.status IN ('READY','EDITING') AND d.retention_started_at>statement_timestamp()-interval '5 years')`,
        [id],
      )
    ).rowCount;
  }

  async activeCount() {
    const row = (
      await this.database.pool.query<{ activeCallCount: number; observedAt: Date }>(
        `SELECT count(*)::int AS "activeCallCount",statement_timestamp() AS "observedAt"
       FROM call_sessions WHERE registered_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL
        AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')`,
      )
    ).rows[0];
    return { activeCallCount: row.activeCallCount, observedAt: row.observedAt.toISOString() };
  }

  constructor(private readonly database: DatabaseService) {}

  async findMany(query: CallQueryDto): Promise<PageRows<CallListItemDto>> {
    const conditions: string[] = [
      "c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')",
    ];
    const values: Array<string | number | boolean> = [];
    for (const [value, column, operator] of [
      [query.orderSeq, 'c.order_seq', '='],
      [query.orderStatus, 'o.status', '='],
      [query.callerPhoneNumber, 'c.caller_phone_number', '='],
      [query.from, CALL_STARTED_AT, '>='],
      [query.to, CALL_STARTED_AT, '<'],
      [query.hasComplaint, 'a.has_complaint', '='],
      [query.aiPersonaVersionSeq, 'a.ai_persona_version_seq', '='],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        conditions.push(`${column} ${operator} $${values.length}`);
      }
    }
    if (query.q) {
      values.push(query.q);
      const parameter = `$${values.length}`;
      conditions.push(`(strpos(lower(normalize(customer.name,NFC)),lower(normalize(${parameter},NFC)))>0
        OR strpos(c.caller_phone_number,${parameter})>0)`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await readPage<CallRow>(
      this.database.pool,
      `${CALL_SELECT} ${where}`,
      values,
      query,
      '"startedAt" DESC NULLS LAST,"callSessionSeq" DESC',
    );
    return { ...result, rows: result.rows.map(callResult) };
  }

  async findOne(id: number): Promise<CallListItemDto | undefined> {
    const result = await this.database.pool.query<CallRow>(
      `${CALL_SELECT} WHERE c.call_session_seq=$1 AND c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')`,
      [id],
    );
    return result.rows[0] ? callResult(result.rows[0]) : undefined;
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

  async findTranscript(id: number, query: TranscriptQueryDto): Promise<PageRows<UtteranceDto>> {
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
}
