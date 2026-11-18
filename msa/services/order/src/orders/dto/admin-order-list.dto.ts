import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { OrderQueryDto } from './order-query.dto';
import { OrderAddressValueDto, OrderParcelDto, OrderSummaryDto } from './order-response.dto';

export class AdminOrderListQueryDto extends PickType(OrderQueryDto, [
  'from',
  'to',
  'limit',
  'offset',
] as const) {
  @ApiPropertyOptional({
    description:
      '발송인·수령인 이름·전화번호·주소의 부분 검색. NFC·대소문자 무시. %·_는 일반 문자.',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @Matches(/^[^\0]*$/u)
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    enum: ['COLLECTING', 'notPaid', 'PAID', 'SUBMISSION_FAILED', 'CANCELLED'],
    description:
      '목록 탭. PAID는 PAID·SUBMITTING·ACCEPTED, SUBMISSION_FAILED는 재시도 중 실패(SUBMITTING_FAILED)와 최종 실패(SUBMISSION_FAILED)를 조회합니다. 전체는 생략합니다.',
  })
  @IsOptional()
  @IsIn(['COLLECTING', 'notPaid', 'PAID', 'SUBMISSION_FAILED', 'CANCELLED'])
  statusGroup?: 'COLLECTING' | 'notPaid' | 'PAID' | 'SUBMISSION_FAILED' | 'CANCELLED';
}

export class OrderListPartyDto extends PickType(OrderAddressValueDto, [
  'name',
  'phoneNumber',
  'roadAddress',
  'jibunAddress',
  'detailAddress',
] as const) {}

export class OrderListParcelDto extends PickType(OrderParcelDto, [
  'orderParcelSeq',
  'status',
  'documentCount',
  'smallBoxCount',
  'mediumBoxCount',
  'bigBoxCount',
  'otherItemDescription',
] as const) {
  @ApiProperty({ type: OrderListPartyDto, description: '주문에 저장한 발송인. 미수집 값은 null.' })
  origin!: OrderListPartyDto;
  @ApiProperty({ type: OrderListPartyDto, description: '주문에 저장한 수령인. 미수집 값은 null.' })
  destination!: OrderListPartyDto;
}

export class AdminOrderListItemDto extends PickType(OrderSummaryDto, [
  'orderSeq',
  'status',
  'createdAt',
  'pickupRequestedAt',
] as const) {
  @ApiProperty({
    type: [OrderListParcelDto],
    description:
      '모든 배송상세를 주문 내 순번대로 반환. 취소 상세는 status=CANCELLED로 구분하며 상세 없는 주문은 빈 배열.',
  })
  parcels!: OrderListParcelDto[];
}

export class AdminOrderListResponseDto {
  @ApiProperty({ type: [AdminOrderListItemDto] })
  data!: AdminOrderListItemDto[];
  @ApiProperty({ description: '다음 주문 페이지가 있으면 true.' })
  hasNext!: boolean;
  @ApiProperty({
    minimum: 0,
    type: 'integer',
    description: '검색·기간·상태 탭 조건을 모두 만족하는 주문 수. 페이지 제한 적용 전 개수.',
  })
  total_count!: number;
}
