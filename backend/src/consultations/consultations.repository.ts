import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDto, HandoffDto } from './dto/call-response.dto';

type CallRow = Omit<CallDto, 'handoff'> & {
  handoffRequestSeq: number | null;
  handoffReason: string;
  handoffStatus: HandoffDto['status'];
  assignedAdminUserSeq: number | null;
  summaryText: string | null;
  requestedAt: Date;
};

const CALL_SELECT = `SELECT c.call_session_seq AS "callSessionSeq",c.provider_call_id AS "providerCallId",
 c.caller_phone_number AS "callerPhoneNumber",c.order_seq AS "orderSeq",
 c.started_at AS "startedAt",c.ended_at AS "endedAt",c.end_reason AS "endReason",
 h.handoff_request_seq AS "handoffRequestSeq",h.reason AS "handoffReason",h.status AS "handoffStatus",
 h.assigned_admin_user_seq AS "assignedAdminUserSeq",h.summary_text AS "summaryText",h.requested_at AS "requestedAt"
 FROM call_sessions c LEFT JOIN handoff_requests h ON h.call_session_seq=c.call_session_seq`;

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
}
