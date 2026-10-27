import { CreateOrderDto, OrderAddressPatchDto } from './dto/create-order.dto';

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
  return {
    customerSeq: input.customerSeq,
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
    })),
  };
}

export type OrderDraft = ReturnType<typeof orderDraft>;
