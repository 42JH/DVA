import { isISO8601 } from 'class-validator';
import { OrderAddressDto, OrderInputDto } from './dto/order-input.dto';

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
export const QUANTITY_FIELDS = [
  'documentCount',
  'smallBoxCount',
  'mediumBoxCount',
  'bigBoxCount',
] as const;
export function isZonedDate(value: string): boolean {
  return (
    isISO8601(value, { strict: true, strictSeparator: true }) &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function address(value: OrderAddressDto = {}): Required<OrderAddressDto> {
  return Object.fromEntries(
    ORDER_ADDRESS_FIELDS.map((key) => [key, value[key] ?? null]),
  ) as Required<OrderAddressDto>;
}

// 원문을 보존하면서 키 순서와 동등한 타임존 표현만 고정한다. 미수집 값은 null이다.
export function orderSnapshot(input: OrderInputDto) {
  return {
    paymentMethodType: input.paymentMethodType ?? null,
    pickupRequestedAt:
      input.pickupRequestedAt && isZonedDate(input.pickupRequestedAt)
        ? new Date(input.pickupRequestedAt).toISOString()
        : (input.pickupRequestedAt ?? null),
    parcels: (input.parcels ?? []).map((parcel) => ({
      origin: address(parcel.origin ?? {}),
      destination: address(parcel.destination ?? {}),
      documentCount: parcel.documentCount ?? null,
      smallBoxCount: parcel.smallBoxCount ?? null,
      mediumBoxCount: parcel.mediumBoxCount ?? null,
      bigBoxCount: parcel.bigBoxCount ?? null,
      otherItemDescription: parcel.otherItemDescription ?? null,
      clientComment: parcel.clientComment ?? null,
      notifiedPrice: parcel.notifiedPrice ?? null,
      itemPrice: parcel.itemPrice ?? null,
    })),
  };
}
export type OrderSnapshot = ReturnType<typeof orderSnapshot>;
