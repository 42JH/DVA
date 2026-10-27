import { ApiProperty, OmitType } from '@nestjs/swagger';
import { OriginPinDto } from './create-order.dto';
import { ORDER_STATUSES, OrderStatus, SHIPMENT_STATUSES, ShipmentStatus } from '../orders.types';

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

export class OrderSummaryDto {
  @ApiProperty({ description: '주문 번호(orderSeq).', minimum: 1 })
  orderSeq!: number;

  @ApiProperty({
    description: '주문 고객 번호. 연결되지 않은 기존 데이터는 null.',
    type: Number,
    nullable: true,
  })
  customerSeq!: number | null;

  @ApiProperty({ description: '주문 처리 상태.', enum: ORDER_STATUSES })
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
    description: '주문에 저장된 전체 상세 수. 수집 중에는 0일 수 있습니다.',
    minimum: 0,
  })
  parcelCount!: number;

  @ApiProperty({
    description: '저장된 배송 상태 목록(중복 제거). 배송이 없으면 빈 배열.',
    enum: SHIPMENT_STATUSES,
    isArray: true,
  })
  shipmentStatuses!: ShipmentStatus[];
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

export class OrderShipmentDto {
  @ApiProperty({ description: '배송 번호(shipmentSeq).', minimum: 1 })
  shipmentSeq!: number;

  @ApiProperty({ description: '배송에 연결된 주문 상세 번호.', minimum: 1 })
  orderParcelSeq!: number;

  @ApiProperty({ description: '내부 고유 추적번호. 택배사 송장 번호가 아닙니다.' })
  trackingNumber!: string;

  @ApiProperty({
    description: '팀 DB에 저장된 배송 상태. 실시간 택배사 조회 결과가 아닙니다.',
    enum: SHIPMENT_STATUSES,
  })
  status!: ShipmentStatus;

  @ApiProperty({ description: '배송 상태 변경 버전. 주문 version과 별개입니다.', minimum: 1 })
  version!: number;

  @ApiProperty({ description: '마지막 배송 상태 변경 시각.', format: 'date-time' })
  statusChangedAt!: string;

  @ApiProperty({ description: '배송 데이터 생성 시각.', format: 'date-time' })
  createdAt!: string;
}

export class OrderParcelDto {
  @ApiProperty({
    description: '주문 상세 번호. ORD-04에서 기존 상세를 수정할 때 사용합니다.',
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

  @ApiProperty({
    description: '저장된 배송 정보. 배송 생성 전에는 null.',
    type: OrderShipmentDto,
    nullable: true,
  })
  shipment!: OrderShipmentDto | null;
}

export class OrderDetailDto extends OmitType(OrderSummaryDto, [
  'parcelCount',
  'shipmentStatuses',
] as const) {
  @ApiProperty({
    description:
      'DB의 현재 주문 버전. ORD-04 수정·ORD-06 최종 접수의 expectedVersion으로 사용합니다.',
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
    description: '디버 접수 확인 시각. 접수 전에는 null.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  dverReceivedAt!: string | null;

  @ApiProperty({ description: '주문 최종 변경 시각.', format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({
    description: 'parcelPosition 오름차순의 상세 목록. 수집 중에는 빈 배열일 수 있습니다.',
    type: [OrderParcelDto],
  })
  parcels!: OrderParcelDto[];
}
