import { ApiProperty } from '@nestjs/swagger';
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
      '결제 방식. cat: 방문, billing: 개인 카드, credit: 월정산, groupBilling: 그룹 카드.',
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
