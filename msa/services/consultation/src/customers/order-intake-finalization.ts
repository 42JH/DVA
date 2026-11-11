import type { PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import {
  validateFinalization,
  type IntakeFinalization,
} from '@dva/events/order-intake-write.cjs';
import { ApiException } from '../common/errors/api.exception';
import type { AuditService } from '../audit/audit.service';
export async function applyIntakeFinalization(
  client: PoolClient,
  data: IntakeFinalization,
  audit: AuditService,
) {
  validateFinalization(data);
  const call = (
    await client.query<{
      version: number;
      orderSeq: number | null;
      finalizedAt: Date | null;
      completion: unknown;
    }>(
      'SELECT order_intake_version AS version,order_seq AS "orderSeq",order_finalized_at AS "finalizedAt",order_completion_payload AS completion FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE',
      [data.callSessionSeq],
    )
  ).rows[0];
  if (!call)
    throw new ApiException(
      503,
      'DEPENDENCY_UNAVAILABLE',
      '서비스를 일시적으로 사용할 수 없습니다.',
    );
  const existing = (
    await client.query<{
      payload: IntakeFinalization;
      source: string;
      event_type: string;
    }>('SELECT payload,source,event_type FROM inbox_events WHERE event_id=$1', [
      data.eventId,
    ])
  ).rows[0];
  if (existing) {
    if (
      existing.source !== 'order' ||
      existing.event_type !== 'OrderIntakeFinalized' ||
      !isDeepStrictEqual(existing.payload, data)
    )
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '같은 이벤트의 내용을 변경할 수 없습니다.',
      );
    return 'duplicate' as const;
  }
  if (
    call.version !== data.expectedIntakeVersion ||
    !call.completion ||
    call.finalizedAt ||
    call.orderSeq !== null
  )
    throw new ApiException(
      409,
      'INVALID_STATE',
      '확정 전에 다른 주문이 연결되어 있습니다.',
    );
  await client.query(
    "INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,'order','OrderIntakeFinalized',$2)",
    [data.eventId, data],
  );
  await client.query(
    `UPDATE call_sessions SET order_seq=$2,order_finalized_at=$3,order_finalization_result=$4::jsonb,
    order_finalization_error_code=NULL,order_finalization_attempted_at=$3 WHERE call_session_seq=$1`,
    [
      data.callSessionSeq,
      data.orderSeq,
      data.finalizedAt,
      JSON.stringify({
        orderSeq: data.orderSeq,
        parcelMappings: data.parcelMappings,
      }),
    ],
  );
  await audit.recordSuccess(
    {
      actorId: null,
      actorType: 'SYSTEM',
      targetId: data.callSessionSeq,
      targetType: 'CALL_SESSION',
      action: 'ORDER_INTAKE_FINALIZED',
      requestId: data.requestId,
    },
    client,
  );
  return 'processed' as const;
}
