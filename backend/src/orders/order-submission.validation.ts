import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import { ORDER_ADDRESS_FIELDS, OrderDraft } from './order-draft';

// 입력 형식 검증을 통과한 주문의 완전성만 검사한다. 저장 중인 초안에는 호출하지 않는다.
export function assertOrderSubmissionReady(draft: OrderDraft): void {
  const errors: ErrorDetail[] = [];
  if (draft.pickupRequestedAt === null)
    errors.push({ field: 'pickupRequestedAt', reason: 'required' });
  if (draft.parcels.length === 0) errors.push({ field: 'parcels', reason: 'atLeastOne' });
  for (const [index, parcel] of draft.parcels.entries()) {
    const prefix = `parcels.${index}`;
    for (const side of ['origin', 'destination'] as const) {
      for (const field of ORDER_ADDRESS_FIELDS) {
        if (field === 'detailAddress') continue;
        const value = parcel[side][field];
        if (value === null || (typeof value === 'string' && value.trim() === ''))
          errors.push({ field: `${prefix}.${side}.${field}`, reason: 'required' });
      }
    }
    if (parcel.itemPrice === null)
      errors.push({ field: `${prefix}.itemPrice`, reason: 'required' });
    if (
      parcel.documentCount + parcel.smallBoxCount + parcel.mediumBoxCount + parcel.bigBoxCount ===
        0 &&
      parcel.otherItemDescription.trim() === ''
    )
      errors.push({ field: prefix, reason: 'itemRequired' });
  }
  if (errors.length)
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      '접수에 필요한 주문 정보를 확인해 주세요.',
      errors,
    );
}
