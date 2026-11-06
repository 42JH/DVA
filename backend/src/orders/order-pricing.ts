import { ApiException } from '../common/errors/api.exception';
import { MAX_ORDER_ITEM_PRICE, MIN_ORDER_ITEM_PRICE } from './orders.types';

export function orderItemPriceError(value: number | null): 'required' | 'priceRange' | null {
  if (value === null) return 'required';
  return Number.isSafeInteger(value) &&
    value >= MIN_ORDER_ITEM_PRICE &&
    value <= MAX_ORDER_ITEM_PRICE
    ? null
    : 'priceRange';
}

export function assertOrderAmount(order: {
  totalAmount: number | null;
  parcels: { notifiedPrice: number | null; status?: string }[];
}): void {
  const amount = order.parcels
    .filter((p) => p.status !== 'CANCELLED')
    .reduce((sum, p) => sum + (p.notifiedPrice ?? 0), 0);
  if (
    !Number.isInteger(order.totalAmount) ||
    order.totalAmount! <= 0 ||
    amount > 2147483647 ||
    order.totalAmount !== amount
  )
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      '주문 총액과 상세별 배송비 합계를 확인해 주세요.',
      [{ field: 'totalAmount', reason: 'mustMatchActiveParcelFees' }],
    );
}
