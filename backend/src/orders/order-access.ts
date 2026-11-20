import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { OrdersRepository } from './orders.repository';

export function orderCallId(adminId: number | null, header?: string): number | null {
  if (
    (adminId === null && header === undefined) ||
    (header !== undefined &&
      (!/^[0-9]+$/.test(header) || Number(header) < 1 || Number(header) > 2147483647))
  )
    throw new ApiException(
      400,
      'INVALID_REQUEST',
      'AI 주문 API에는 유효한 call_session_seq가 필요합니다.',
    );
  return header === undefined ? null : Number(header);
}

export async function readOrderCustomer(
  repository: OrdersRepository,
  client: PoolClient,
  adminId: number | null,
  callId: number | null,
  orderId?: number,
  draftCancellation = false,
) {
  if (adminId !== null) return null;
  const call = await repository.readCustomer(client, callId!);
  if (!call && draftCancellation)
    throw new ApiException(
      409,
      'INVALID_STATE',
      '신규 통화의 수정·취소는 배송 초안 API를 사용해 주세요.',
    );
  if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
  if (call.endedAt !== null && call.orderSeq !== orderId)
    throw new ApiException(
      409,
      'INVALID_STATE',
      '종료된 통화는 기존 연결 주문만 사용할 수 있습니다.',
    );
  if (call.customerSeq === null)
    throw new ApiException(403, 'FORBIDDEN', '통화 발신번호에 연결된 활성 고객이 필요합니다.');
  return call.customerSeq;
}
