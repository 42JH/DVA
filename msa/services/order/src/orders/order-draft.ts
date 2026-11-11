import { isISO8601 } from 'class-validator';
import { ApiException } from '../common/errors/api.exception';
import type { OrderAddressPatchDto, ParcelInputDto } from './dto/create-order.dto';
type DraftInput = {
  customerSeq?: number;
  customer?: { name: string; phoneNumber: string };
  paymentMethodType?: string | null;
  totalAmount?: number | null;
  pickupRequestedAt?: string | null;
  parcels?: ParcelInputDto[];
};

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
] as const;

function address(value: OrderAddressPatchDto = {}): Required<OrderAddressPatchDto> {
  return Object.fromEntries(
    ORDER_ADDRESS_FIELDS.map((key) => [key, value[key] ?? null]),
  ) as Required<OrderAddressPatchDto>;
}

// 저장 기본값과 키 순서를 고정해 같은 입력의 재전송을 동일하게 비교한다.
export function orderDraft(input: DraftInput) {
  if (input.pickupRequestedAt && !isZonedDate(input.pickupRequestedAt))
    throw new ApiException(400, 'INVALID_REQUEST', '수거 시각을 확인해 주세요.');
  return {
    customerSeq: input.customerSeq,
    ...(input.customer
      ? { customer: { name: input.customer.name, phoneNumber: input.customer.phoneNumber } }
      : {}),
    paymentMethodType: input.paymentMethodType ?? null,
    totalAmount: input.totalAmount ?? null,
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
      notifiedPrice: parcel.notifiedPrice ?? null,
    })),
  };
}

export type OrderDraft = ReturnType<typeof orderDraft>;

export function hasOrderData(draft: OrderDraft): boolean {
  if (
    draft.paymentMethodType !== null ||
    draft.pickupRequestedAt !== null ||
    draft.totalAmount !== null
  )
    return true;
  return draft.parcels.some(
    (parcel) =>
      parcel.originPin !== null ||
      [parcel.origin, parcel.destination].some((value) =>
        Object.values(value).some((field) =>
          typeof field === 'string' ? field.trim() !== '' : field !== null,
        ),
      ) ||
      [parcel.documentCount, parcel.smallBoxCount, parcel.mediumBoxCount, parcel.bigBoxCount].some(
        (count) => count > 0,
      ) ||
      parcel.otherItemDescription.trim() !== '' ||
      parcel.clientComment.trim() !== '' ||
      parcel.itemPrice !== null ||
      parcel.notifiedPrice !== null,
  );
}
