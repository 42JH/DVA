import { ApiProperty, OmitType } from '@nestjs/swagger';
import { OriginPinDto } from './create-order.dto';
import {
  ORDER_CREATION_SOURCES,
  OrderCreationSource,
  ORDER_STATUSES,
  OrderStatus,
} from '../orders.types';

export class CreatedOrderDto {
  @ApiProperty({
    minimum: 1,
    description: '생성된 주문 번호. 같은 생성 키 재시도 시 기존 주문 번호.',
  })
  orderSeq!: number;

  @ApiProperty({
    minimum: 1,
    description: '현재 주문 버전. 생성 키 재시도에도 최신 저장 버전을 반환합니다.',
  })
  version!: number;
}

export class OrderResultDto extends CreatedOrderDto {
  @ApiProperty({
    enum: ORDER_STATUSES,
    description:
      'ACCEPTED만 디버 접수 성공. SUBMITTING은 처리 중, AUTH_FAILED·REVIEW_REQUIRED는 성공으로 안내하지 않습니다.',
  })
  status!: OrderStatus;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '연결된 call_sessions.call_session_seq. 통화 없는 관리자 주문은 null.',
  })
  callSessionSeq!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '디버 접수 참고번호. 접수 성공 전에는 null.',
  })
  parcelNo!: string | null;
}

export class OrderSummaryDto {
  @ApiProperty({
    enum: ORDER_CREATION_SOURCES,
    description: '접수 경로. AI: AI 상담, ADMIN: 관리자 수기, UNKNOWN: 기존 출처 미확인.',
  })
  creationSource!: OrderCreationSource;

  @ApiProperty({ description: '주문 번호(orderSeq).', minimum: 1 })
  orderSeq!: number;

  @ApiProperty({
    description: '주문 고객 번호. 고객을 확인하지 못한 미완료·취소 주문은 null일 수 있습니다.',
    type: Number,
    nullable: true,
  })
  customerSeq!: number | null;

  @ApiProperty({
    description:
      '주문 상태: COLLECTING 미완료, SUBMITTING 접수 중, ACCEPTED 접수 완료, AUTH_FAILED 인증 실패, REVIEW_REQUIRED 확인 필요, CANCELLED 전체 취소, EXPIRED 만료. 일부 상세만 취소하면 기존 상태 유지.',
    enum: ORDER_STATUSES,
    example: 'COLLECTING',
  })
  status!: OrderStatus;

  @ApiProperty({
    description:
      'credit: 공통 정산, groupBilling: 기업 그룹카드, billing: 개인카드. cat은 과거 저장값으로 조회만 가능하며 신규 입력·접수는 불가.',
    enum: ['cat', 'billing', 'credit', 'groupBilling'],
  })
  paymentMethodType!: 'cat' | 'billing' | 'credit' | 'groupBilling';

  @ApiProperty({
    description: '수거 요청 시각. 미수집 시 null.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  pickupRequestedAt!: string | null;

  @ApiProperty({ description: '주문 생성 시각.', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    description: '취소된 상세를 포함한 전체 상세 수. 수집 중에는 0일 수 있습니다.',
    minimum: 0,
  })
  parcelCount!: number;
}

export class OrderAddressValueDto {
  @ApiProperty({ description: '발송인 또는 수령인 이름.', type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ description: '숫자 문자열 연락처. 선행 0 보존.', type: String, nullable: true })
  phoneNumber!: string | null;

  @ApiProperty({ description: '도로명 주소.', type: String, nullable: true })
  roadAddress!: string | null;

  @ApiProperty({ description: '지번 주소.', type: String, nullable: true })
  jibunAddress!: string | null;

  @ApiProperty({ description: '상세 주소.', type: String, nullable: true })
  detailAddress!: string | null;

  @ApiProperty({ description: '읍·면·동 이름.', type: String, nullable: true })
  dongName!: string | null;

  @ApiProperty({ description: '우편번호. 선행 0 보존.', type: String, nullable: true })
  postalCode!: string | null;

  @ApiProperty({ description: '위도.', type: Number, nullable: true, minimum: -90, maximum: 90 })
  latitude!: number | null;

  @ApiProperty({ description: '경도.', type: Number, nullable: true, minimum: -180, maximum: 180 })
  longitude!: number | null;
}

export class OrderParcelDto {
  @ApiProperty({
    enum: ['ACTIVE', 'CANCELLED'],
    description: '상세 취소 상태. ACTIVE는 취소되지 않음이며 결제·접수 완료를 뜻하지 않습니다.',
  })
  status!: 'ACTIVE' | 'CANCELLED';

  @ApiProperty({
    description: '주문 상세 번호. 기존 상세의 주소·물품을 수정할 때 사용합니다.',
    minimum: 1,
  })
  orderParcelSeq!: number;

  @ApiProperty({ description: '소속 주문 번호.', minimum: 1 })
  orderSeq!: number;

  @ApiProperty({ description: '주문 내 상세 순번. 이 순서로 응답합니다.', minimum: 1 })
  parcelPosition!: number;

  @ApiProperty({
    description: '주문에 저장된 출발지. 미수집 필드는 null.',
    type: OrderAddressValueDto,
  })
  origin!: OrderAddressValueDto;

  @ApiProperty({
    description: '주문에 저장된 도착지. 미수집 필드는 null.',
    type: OrderAddressValueDto,
  })
  destination!: OrderAddressValueDto;

  @ApiProperty({
    description: '출발지 원본 주소록 참조. 원본의 현재 내용을 다시 읽지 않습니다.',
    type: OriginPinDto,
    nullable: true,
  })
  originPin!: OriginPinDto | null;

  @ApiProperty({ description: '서류 수량.', minimum: 0 })
  documentCount!: number;

  @ApiProperty({ description: '소형 박스 수량.', minimum: 0 })
  smallBoxCount!: number;

  @ApiProperty({ description: '중형 박스 수량.', minimum: 0 })
  mediumBoxCount!: number;

  @ApiProperty({ description: '대형 박스 수량.', minimum: 0 })
  bigBoxCount!: number;

  @ApiProperty({ description: '기타 물품 설명. 미입력 시 빈 문자열.' })
  otherItemDescription!: string;

  @ApiProperty({ description: '배송 요청 사항. 미입력 시 빈 문자열.' })
  clientComment!: string;

  @ApiProperty({ description: '상세별 안내 배송비(원). 다중 물품 총액이 아닙니다.', enum: [3500] })
  notifiedPrice!: number;

  @ApiProperty({
    description: '물품 가액(원). 미수집 시 null.',
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  itemPrice!: number | null;
}

export class OrderDetailDto extends OmitType(OrderSummaryDto, ['parcelCount'] as const) {
  @ApiProperty({
    description: '현재 주문 버전. 수정·최종 접수의 expectedVersion으로 사용합니다.',
    minimum: 1,
  })
  version!: number;

  @ApiProperty({
    description: '디버 접수 참고값. 중복 가능하며 주문 식별자로 사용하지 않습니다.',
    type: String,
    nullable: true,
  })
  parcelNo!: string | null;

  @ApiProperty({
    description: '디버 접수 확인 시각. 접수 전에는 null이며 접수 후 취소해도 보존합니다.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  dverReceivedAt!: string | null;

  @ApiProperty({ description: '주문 최종 변경 시각.', format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({
    description:
      '취소된 상세도 포함한 parcelPosition 오름차순 목록. 수집 중에는 빈 배열일 수 있습니다.',
    type: [OrderParcelDto],
  })
  parcels!: OrderParcelDto[];
}
