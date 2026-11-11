import type { PoolClient } from 'pg';
import {
  validateReceipt,
  validateCallMutation,
  validateOrderCallLink,
  type OwnerCallWriteReceipt,
  type CallOrderLink,
} from '@dva/events/parcel-draft-write.cjs';
import { ApiException } from '../common/errors/api.exception';

export async function applyDraftCallWrite(
  client: PoolClient,
  receipt: OwnerCallWriteReceipt,
  alreadyApplied = false,
) {
  validateReceipt(receipt);
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
