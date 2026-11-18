import { ApiException } from '../common/errors/api.exception';
import { UpdateOrderDto } from './dto/update-order.dto';
import { isZonedDate } from './order-draft';

export function assertOrderUpdate(input: UpdateOrderDto): void {
  if (input.pickupRequestedAt && !isZonedDate(input.pickupRequestedAt))
    throw new ApiException(400, 'INVALID_REQUEST', '수거 시각을 확인해 주세요.');

  const removed = new Set(input.removeParcelSeqs ?? []);
  const ids = new Set<number>();
  for (const parcel of input.parcels ?? []) {
    if (parcel.orderParcelSeq !== undefined) {
      if (ids.has(parcel.orderParcelSeq))
        throw new ApiException(400, 'INVALID_REQUEST', '같은 상세 번호를 중복 전달할 수 없습니다.');
      if (removed.has(parcel.orderParcelSeq))
        throw new ApiException(
          400,
          'INVALID_REQUEST',
          '같은 상세를 수정하면서 제거할 수 없습니다.',
        );
      ids.add(parcel.orderParcelSeq);
    }
    const hasChange = Object.entries(parcel).some(([field, value]) => {
      if (field === 'orderParcelSeq' || value === undefined) return false;
      if (field === 'origin' || field === 'destination')
        return Object.values(value).some((item) => item !== undefined);
      return true;
    });
    if (!hasChange)
      throw new ApiException(400, 'INVALID_REQUEST', '각 상세에 변경할 필드를 전달해 주세요.');
  }
  if (
    input.paymentMethodType === undefined &&
    input.pickupRequestedAt === undefined &&
    input.totalAmount === undefined &&
    !input.parcels?.length &&
    !input.removeParcelSeqs?.length
  )
    throw new ApiException(400, 'INVALID_REQUEST', '변경할 필드를 하나 이상 전달해 주세요.');
}
