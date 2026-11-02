import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDto, CallListItemDto, HandoffDto, RecordingDto } from './dto/call-response.dto';
import { CallAnalysisDto } from './dto/call-analysis-response.dto';
import { TranscriptQueryDto, UtteranceDto } from './dto/transcript.dto';

type RecordingRow = Pick<RecordingDto, 'recordingSeq' | 'createdAt'> & { objectKey: string };

type CallRow = Omit<CallDto, 'handoff'> & {
  aiPersonaVersionSeq: number | null;
  personaName: string | null;
  personaVersion: number | null;
  isNewCustomer: boolean | null;
  registeredParcelCount: number | null;
  faqAnswerCount: number | null;
  orderLookupCount: number | null;
  cancelledParcelCount: number | null;
  hasHandoffRequest: boolean | null;
  aiStartedAt: Date | null;
  aiEndedAt: Date | null;
  repeatQuestionCount: number | null;
  hasComplaint: boolean | null;
  complaints: CallAnalysisDto['complaints'] | null;
  analysedAt: Date | null;
  handoffRequestSeq: number | null;
  handoffReason: string;
  handoffStatus: HandoffDto['status'];
  assignedAdminUserSeq: number | null;
  summaryText: string | null;
  requestedAt: Date;
};

const CALL_STARTED_AT = 'COALESCE(c.started_at,a.ai_started_at,c.incoming_at)';

const CALL_SELECT = `SELECT c.call_session_seq AS "callSessionSeq",c.provider_call_id AS "providerCallId",
 c.caller_phone_number AS "callerPhoneNumber",c.order_seq AS "orderSeq",o.status AS "orderStatus",o.total_amount AS "orderTotalAmount",
 ${CALL_STARTED_AT} AS "startedAt",COALESCE(c.ended_at,a.ai_ended_at) AS "endedAt",c.end_reason AS "endReason",
 customer.customer_seq AS "customerSeq",customer.name AS "customerName",
 a.ai_persona_version_seq AS "aiPersonaVersionSeq",v.name AS "personaName",v.version AS "personaVersion",
 a.ai_started_at AS "aiStartedAt",a.ai_ended_at AS "aiEndedAt",a.repeat_question_count AS "repeatQuestionCount",
 a.has_complaint AS "hasComplaint",a.complaints,a.analysed_at AS "analysedAt",
 a.is_new_customer AS "isNewCustomer",a.registered_parcel_count AS "registeredParcelCount",
 a.faq_answer_count AS "faqAnswerCount",a.order_lookup_count AS "orderLookupCount",
 a.cancelled_parcel_count AS "cancelledParcelCount",a.has_handoff_request AS "hasHandoffRequest",
 h.handoff_request_seq AS "handoffRequestSeq",h.reason AS "handoffReason",h.status AS "handoffStatus",
 h.assigned_admin_user_seq AS "assignedAdminUserSeq",h.summary_text AS "summaryText",h.requested_at AS "requestedAt"
 FROM call_sessions c LEFT JOIN orders o ON o.order_seq=c.order_seq
 LEFT JOIN handoff_requests h ON h.call_session_seq=c.call_session_seq
 LEFT JOIN customers customer ON customer.customer_seq=COALESCE(o.customer_seq,c.customer_seq)
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
    aiStartedAt,
    aiEndedAt,
    repeatQuestionCount,
    hasComplaint,
    complaints,
    analysedAt,
    handoffRequestSeq,
    handoffReason,
    handoffStatus,
    assignedAdminUserSeq,
    summaryText,
    requestedAt,
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
            aiStartedAt: aiStartedAt!,
            aiEndedAt: aiEndedAt!,
            repeatQuestionCount,
            hasComplaint,
            complaints: complaints!,
            analysedAt,
          },
    handoff:
      handoffRequestSeq === null
        ? null
        : {
            handoffRequestSeq,
            reason: handoffReason,
            status: handoffStatus,
            assignedAdminUserSeq,
            summaryText,
            requestedAt,
          },
  };
}

@Injectable()
export class ConsultationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findMany(query: CallQueryDto): Promise<PageRows<CallListItemDto>> {
    const conditions: string[] = [];
    const values: Array<string | number | boolean> = [];
    for (const [value, column, operator] of [
      [query.orderSeq, 'c.order_seq', '='],
      [query.orderStatus, 'o.status', '='],
      [query.callerPhoneNumber, 'c.caller_phone_number', '='],
      [query.from, CALL_STARTED_AT, '>='],
      [query.to, CALL_STARTED_AT, '<'],
      [query.endReason, 'c.end_reason', '='],
      [query.handoffStatus, 'h.status', '='],
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
      `${CALL_SELECT} WHERE c.call_session_seq=$1`,
      [id],
    );
    return result.rows[0] ? callResult(result.rows[0]) : undefined;
  }

  async findRecordings(id: number): Promise<RecordingRow[]> {
    return (
      await this.database.pool.query<RecordingRow>(
        `SELECT recording_seq AS "recordingSeq",created_at AS "createdAt",object_key AS "objectKey"
       FROM recordings WHERE call_session_seq=$1 ORDER BY recording_seq`,
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
