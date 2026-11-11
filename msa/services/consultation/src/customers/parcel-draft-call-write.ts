import type { PoolClient } from 'pg';
import {
  validateReceipt,
  validateCallMutation,
  validateOrderCallLink,
  type OwnerCallWriteReceipt,
  type CallOrderLink,
  type LegacyCallWrite,
} from '@dva/events/parcel-draft-write.cjs';
import { ApiException } from '../common/errors/api.exception';
import type { ConsultationsService } from '../consultations/consultations.service';

export async function applyDraftCallWrite(
  client: PoolClient,
  receipt: OwnerCallWriteReceipt,
  alreadyApplied = false,
  calls?: ConsultationsService,
) {
  validateReceipt(receipt);
  if ('creationKey' in receipt.payload)
    return applyLegacyCallWrite(
      client,
      receipt.eventId,
      receipt.payload,
      calls,
    );
  if ('beforeOrderSeq' in receipt.payload)
    return applyOrderCallLink(client, receipt.eventId, receipt.payload);
  validateCallMutation(receipt.payload);
  const p = receipt.payload;
  // Every receiver locks the call before its inbox row, including synchronous acknowledgements.
  const call = (
    await client.query<{ version: number; customerSeq: number | null }>(
      'SELECT order_intake_version AS version,customer_seq AS "customerSeq" FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE',
      [p.callSessionSeq],
    )
  ).rows[0];
  const inserted = await client.query(
    "INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,'order','ParcelDraftCallWritten',$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
    [receipt.eventId, p],
  );
  if (!inserted.rowCount) {
    const existing = (
      await client.query<{ matches: boolean }>(
        "SELECT source='order' AND event_type='ParcelDraftCallWritten' AND payload=$2::jsonb AS matches FROM inbox_events WHERE event_id=$1",
        [receipt.eventId, p],
      )
    ).rows[0];
    if (!existing?.matches)
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '같은 이벤트의 내용을 변경할 수 없습니다.',
      );
    return 'duplicate' as const;
  }
  if (!call)
    throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
  if (alreadyApplied) {
    if (
      call.version !== p.afterVersion ||
      (p.customerSeq !== null && call.customerSeq !== p.customerSeq)
    )
      throw new ApiException(
        409,
        'INVALID_STATE',
        '통화 주문 입력 상태가 변경되었습니다.',
      );
  } else {
    // Restore the earlier committed association before another draft can change this call.
    const updated = await client.query(
      'UPDATE call_sessions SET order_intake_version=$3,customer_seq=COALESCE($4::int,customer_seq) WHERE call_session_seq=$1 AND order_intake_version=$2',
      [p.callSessionSeq, p.beforeVersion, p.afterVersion, p.customerSeq],
    );
    if (updated.rowCount !== 1)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '통화 주문 입력 상태가 변경되었습니다.',
      );
  }
  return 'processed' as const;
}

async function applyLegacyCallWrite(
  client: PoolClient,
  eventId: string,
  p: LegacyCallWrite,
  calls?: ConsultationsService,
) {
  const previous = (
    await client.query<{ matches: boolean }>(
      "SELECT source='order' AND event_type='LegacyOrderCallWritten' AND payload=$2::jsonb AS matches FROM inbox_events WHERE event_id=$1",
      [eventId, p],
    )
  ).rows[0];
  if (previous) {
    if (!previous.matches)
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '같은 이벤트의 내용을 변경할 수 없습니다.',
      );
    return 'duplicate' as const;
  }
  if (p.call) {
    if (!calls) throw new Error('Call creation recovery is unavailable');
    const available = (
      await client.query<{ available: boolean }>(
        "SELECT deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') AS available FROM call_sessions WHERE call_session_seq=$1",
        [p.callSessionSeq],
      )
    ).rows[0]?.available;
    if (available)
      await calls.recoverOrderCall(client, p.callSessionSeq, p.call);
  }
  const call = (
    await client.query<{ customerSeq: number | null; orderSeq: number | null }>(
      'SELECT customer_seq AS "customerSeq",order_seq AS "orderSeq" FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE',
      [p.callSessionSeq],
    )
  ).rows[0];
  if (!call)
    throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
  const inserted = await client.query(
    "INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,'order','LegacyOrderCallWritten',$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
    [eventId, p],
  );
  if (!inserted.rowCount) {
    const existing = (
      await client.query<{ matches: boolean }>(
        "SELECT source='order' AND event_type='LegacyOrderCallWritten' AND payload=$2::jsonb AS matches FROM inbox_events WHERE event_id=$1",
        [eventId, p],
      )
    ).rows[0];
    if (!existing?.matches)
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '같은 이벤트의 내용을 변경할 수 없습니다.',
      );
    return 'duplicate' as const;
  }
  const updated = await client.query(
    `UPDATE call_sessions SET customer_seq=COALESCE(customer_seq,$3),order_seq=COALESCE(order_seq,$4)
      WHERE call_session_seq=$1 AND (customer_seq IS NOT DISTINCT FROM $2::int OR customer_seq=$3 OR $3::int IS NULL)
      AND (order_seq IS NULL OR order_seq=$4 OR $4::int IS NULL)`,
    [p.callSessionSeq, p.beforeCustomerSeq, p.customerSeq, p.orderSeq],
  );
  if (updated.rowCount !== 1)
    throw new ApiException(
      409,
      'INVALID_STATE',
      '통화 주문 입력 상태가 변경되었습니다.',
    );
  return 'processed' as const;
}

async function applyOrderCallLink(
  client: PoolClient,
  eventId: string,
  p: CallOrderLink,
) {
  validateOrderCallLink(p);
  const call = (
    await client.query<{ orderSeq: number | null; customerSeq: number | null }>(
      'SELECT order_seq AS "orderSeq",customer_seq AS "customerSeq" FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE',
      [p.callSessionSeq],
    )
  ).rows[0];
  const inserted = await client.query(
    "INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,'order','OrderCallLinked',$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
    [eventId, p],
  );
  if (!inserted.rowCount) {
    const existing = (
      await client.query<{ matches: boolean }>(
        "SELECT source='order' AND event_type='OrderCallLinked' AND payload=$2::jsonb AS matches FROM inbox_events WHERE event_id=$1",
        [eventId, p],
      )
    ).rows[0];
    if (!existing?.matches)
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '같은 이벤트의 내용을 변경할 수 없습니다.',
      );
    return 'duplicate' as const;
  }
  if (!call)
    throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
  if (call.orderSeq !== p.orderSeq || call.customerSeq !== p.customerSeq) {
    const updated = await client.query(
      `UPDATE call_sessions SET order_seq=$2,customer_seq=COALESCE(customer_seq,$4)
      WHERE call_session_seq=$1 AND order_seq IS NULL AND (customer_seq IS NOT DISTINCT FROM $3::int OR customer_seq=$4)`,
      [p.callSessionSeq, p.orderSeq, p.beforeCustomerSeq, p.customerSeq],
    );
    if (updated.rowCount !== 1)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '통화 주문 입력 상태가 변경되었습니다.',
      );
  }
  return 'processed' as const;
}
