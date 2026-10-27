import { CreateOrderDto, OrderAddressPatchDto } from './dto/create-order.dto';
import { isISO8601 } from 'class-validator';
import { ApiException } from '../common/errors/api.exception';

export function isZonedDate(value: string): boolean {
  return (
    isISO8601(value, { strict: true, strictSeparator: true }) &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export const ORDER_ADDRESS_FIELDS = [
  'name',
  'phoneNumber',
  'roadAddress',
  'jibunAddress',
  'detailAddress',
  'dongName',
  'postalCode',
  'latitude',
  'longitude',
] as const;

function address(value: OrderAddressPatchDto = {}): Required<OrderAddressPatchDto> {
  return Object.fromEntries(
    ORDER_ADDRESS_FIELDS.map((key) => [key, value[key] ?? null]),
  ) as Required<OrderAddressPatchDto>;
}

// 저장 기본값과 키 순서를 고정해 같은 입력의 재전송을 동일하게 비교한다.
export function orderDraft(input: CreateOrderDto) {
  if (input.pickupRequestedAt && !isZonedDate(input.pickupRequestedAt))
    throw new ApiException(400, 'INVALID_REQUEST', '수거 시각을 확인해 주세요.');
  return {
    customerSeq: input.customerSeq,
    ...(input.customer
      ? { customer: { name: input.customer.name, phoneNumber: input.customer.phoneNumber } }
      : {}),
    paymentMethodType: input.paymentMethodType ?? 'credit',
    pickupRequestedAt: input.pickupRequestedAt
      ? new Date(input.pickupRequestedAt).toISOString()
      : null,
    parcels: (input.parcels ?? []).map((parcel) => ({
      origin: address(parcel.origin),
      destination: address(parcel.destination),
      originPin: parcel.originPin
        ? { scope: parcel.originPin.scope, pinSeq: parcel.originPin.pinSeq }
        : null,
      documentCount: parcel.documentCount ?? 0,
      smallBoxCount: parcel.smallBoxCount ?? 0,
      mediumBoxCount: parcel.mediumBoxCount ?? 0,
      bigBoxCount: parcel.bigBoxCount ?? 0,
      otherItemDescription: parcel.otherItemDescription ?? '',
      clientComment: parcel.clientComment ?? '',
      itemPrice: parcel.itemPrice ?? null,
      notifiedPrice: 3500,
    })),
  };
}

export type OrderDraft = ReturnType<typeof orderDraft>;
