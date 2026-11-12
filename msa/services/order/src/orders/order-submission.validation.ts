import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import {
  DELIVERY_SENDER_PHONE_PATTERN,
  DELIVERY_RECIPIENT_PHONE_PATTERN,
} from '../common/delivery-phone';
import { isZonedDate, ORDER_ADDRESS_FIELDS } from './order-draft';
import type { OrderDetailDto } from './dto/order-response.dto';
import { orderItemPriceError } from './order-pricing';
const QUANTITY_FIELDS = [
  'documentCount',
  'smallBoxCount',
  'mediumBoxCount',
  'bigBoxCount',
] as const;

// 생성 시에는 부분 입력을 허용한다. ORD-06에서 저장된 같은 주문을 검증할 때 사용한다.
export type OrderSubmissionSnapshot = Pick<
  OrderDetailDto,
  'pickupRequestedAt' | 'paymentMethodType'
> & {
  parcels: (Pick<
    OrderDetailDto['parcels'][number],
    | 'origin'
    | 'destination'
    | 'documentCount'
    | 'smallBoxCount'
    | 'mediumBoxCount'
    | 'bigBoxCount'
    | 'otherItemDescription'
    | 'notifiedPrice'
    | 'itemPrice'
    | 'clientComment'
  > & { status?: 'ACTIVE' | 'CANCELLED' })[];
};

export function assertOrderSubmissionReady(
  snapshot: OrderSubmissionSnapshot,
  now = Date.now(),
  requirePickup = true,
): void {
  const errors: ErrorDetail[] = [];
  const missing = (field: string) => errors.push({ field, reason: 'required' });
  const invalid = (field: string, reason: string) => errors.push({ field, reason });
  if (!snapshot.paymentMethodType?.trim()) missing('paymentMethodType');
  else if (!['billing', 'credit', 'groupBilling'].includes(snapshot.paymentMethodType))
    invalid('paymentMethodType', 'unsupported');
  if (requirePickup) {
    if (!snapshot.pickupRequestedAt?.trim()) missing('pickupRequestedAt');
    else if (!isZonedDate(snapshot.pickupRequestedAt))
      invalid('pickupRequestedAt', 'zonedDateTime');
    else if (Date.parse(snapshot.pickupRequestedAt) <= now)
      invalid('pickupRequestedAt', 'mustBeFuture');
  }
  if (!snapshot.parcels.some((parcel) => parcel.status !== 'CANCELLED')) missing('parcels');
  for (const [index, parcel] of snapshot.parcels.entries()) {
    if (parcel.status === 'CANCELLED') continue;
    const prefix = `parcels.${index}`;
    for (const side of ['origin', 'destination'] as const) {
      const address = parcel[side];
      for (const field of ORDER_ADDRESS_FIELDS) {
        if (field === 'detailAddress') continue;
        const value = address[field];
        if (value === null || (typeof value === 'string' && !value.trim()))
          missing(`${prefix}.${side}.${field}`);
      }
      const phonePattern =
        side === 'origin' ? DELIVERY_SENDER_PHONE_PATTERN : DELIVERY_RECIPIENT_PHONE_PATTERN;
      if (address.phoneNumber?.trim() && !phonePattern.test(address.phoneNumber))
        invalid(`${prefix}.${side}.phoneNumber`, side === 'origin' ? 'mobilePhone' : 'phoneNumber');
      if (address.postalCode?.trim() && !/^[0-9]{5}$/.test(address.postalCode))
        invalid(`${prefix}.${side}.postalCode`, 'postalCode');
    }
    for (const field of QUANTITY_FIELDS) {
      const value = parcel[field];
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 2147483647))
        invalid(`${prefix}.${field}`, 'quantityRange');
    }
    if (
      !QUANTITY_FIELDS.some((field) => (parcel[field] ?? 0) > 0) &&
      !parcel.otherItemDescription?.trim()
    )
      missing(`${prefix}.items`);
    const priceError = orderItemPriceError(parcel.itemPrice);
    if (priceError) invalid(`${prefix}.itemPrice`, priceError);
    if (parcel.notifiedPrice === null) missing(`${prefix}.notifiedPrice`);
    else if (
      !Number.isInteger(parcel.notifiedPrice) ||
      parcel.notifiedPrice <= 0 ||
      parcel.notifiedPrice > 2147483647
    )
      invalid(`${prefix}.notifiedPrice`, 'deliveryFeeRange');
  }
  if (errors.length)
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      '접수에 필요한 주문 정보를 확인해 주세요.',
      errors,
    );
}
