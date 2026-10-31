import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDto, HandoffDto, RecordingDto } from './dto/call-response.dto';
import { TranscriptQueryDto, UtteranceDto } from './dto/transcript.dto';

type RecordingRow = Pick<RecordingDto, 'recordingSeq' | 'createdAt'> & { objectKey: string };

type CallRow = Omit<CallDto, 'handoff'> & {
  handoffRequestSeq: number | null;
  handoffReason: string;
  handoffStatus: HandoffDto['status'];
  assignedAdminUserSeq: number | null;
  summaryText: string | null;
  requestedAt: Date;
};

const CALL_SELECT = `SELECT c.call_session_seq AS "callSessionSeq",c.provider_call_id AS "providerCallId",
 c.caller_phone_number AS "callerPhoneNumber",c.order_seq AS "orderSeq",o.status AS "orderStatus",o.total_amount AS "orderTotalAmount",
 c.started_at AS "startedAt",c.ended_at AS "endedAt",c.end_reason AS "endReason",
 h.handoff_request_seq AS "handoffRequestSeq",h.reason AS "handoffReason",h.status AS "handoffStatus",
 h.assigned_admin_user_seq AS "assignedAdminUserSeq",h.summary_text AS "summaryText",h.requested_at AS "requestedAt"
 FROM call_sessions c LEFT JOIN orders o ON o.order_seq=c.order_seq LEFT JOIN handoff_requests h ON h.call_session_seq=c.call_session_seq`;

function callResult(row: CallRow): CallDto {
  const {
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

  async findMany(query: CallQueryDto): Promise<CallDto[]> {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    for (const [value, column, operator] of [
      [query.orderSeq, 'c.order_seq', '='],
      [query.orderStatus, 'o.status', '='],
      [query.callerPhoneNumber, 'c.caller_phone_number', '='],
      [query.from, 'c.started_at', '>='],
      [query.to, 'c.started_at', '<'],
      [query.endReason, 'c.end_reason', '='],
      [query.handoffStatus, 'h.status', '='],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        conditions.push(`${column} ${operator} $${values.length}`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(query.limit + 1, query.offset);
    const result = await this.database.pool.query<CallRow>(
      `${CALL_SELECT} ${where}
       ORDER BY c.started_at DESC NULLS LAST,c.call_session_seq DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map(callResult);
  }

  async findOne(id: number): Promise<CallDto | undefined> {
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

  async findTranscript(id: number, query: TranscriptQueryDto): Promise<UtteranceDto[]> {
    return (
      await this.database.pool.query<UtteranceDto>(
        `SELECT u.call_utterance_seq AS "callUtteranceSeq",u.utterance_order AS "utteranceOrder",u.speaker,
       u.utterance_text AS "utteranceText",u.last_sentence_seq AS "lastSentenceSeq",u.received_at AS "receivedAt",
       e.offset_seconds::double precision AS "offsetSeconds"
       FROM call_utterances u LEFT JOIN call_insight_events e ON e.call_utterance_seq=u.call_utterance_seq
        AND e.call_session_seq=u.call_session_seq AND e.kind='UTTERANCE'
       WHERE u.call_session_seq=$1 ORDER BY u.utterance_order,u.call_utterance_seq
       LIMIT $2 OFFSET $3`,
        [id, query.limit + 1, query.offset],
      )
    ).rows;
  }
}
