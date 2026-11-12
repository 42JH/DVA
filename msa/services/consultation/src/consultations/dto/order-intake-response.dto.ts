import { ApiProperty } from '@nestjs/swagger';
import { ORDER_STATUSES, type OrderStatus } from '@dva/events/order-read.cjs';

export class CreatedOrderDto {
  @ApiProperty({
    minimum: 1,
    description: '생성된 주문 번호. 같은 생성 키 재시도 시 기존 주문 번호.',
  })
  orderSeq!: number;

  @ApiProperty({
    minimum: 1,
    description:
      '현재 주문 버전. 생성 키 재시도에도 최신 저장 버전을 반환합니다.',
  })
  version!: number;
}

export class OrderPaymentRequestDto {
  @ApiProperty() autoCharge!: boolean;
  @ApiProperty() cardPaymentFailed!: boolean;
  @ApiProperty({
    enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'],
    description: '결제 안내 발송 상태. UNKNOWN은 자동 재발송하지 않습니다.',
  })
  notificationStatus!: string;
  @ApiProperty({
    format: 'uuid',
    description: '현재 유효한 내부 결제 요청 식별자.',
  })
  paymentRequestId!: string;
  @ApiProperty({ minimum: 1, description: '이 요청의 결제 금액(원).' })
  amount!: number;
  @ApiProperty({
    format: 'date-time',
    description: '최초 결제 대기 기한. 부분 취소로 연장하지 않습니다.',
  })
  expiresAt!: string;
}

export class OrderResultDto extends CreatedOrderDto {
  @ApiProperty({
    type: OrderPaymentRequestDto,
    nullable: true,
    description: '현재 미완료·미만료 결제 요청. 그 외 null.',
  })
  paymentRequest!: OrderPaymentRequestDto | null;
  @ApiProperty({
    description: '최초 결제 대기 만료 시각. 부분 취소로 연장하지 않습니다.',
    type: String,
    nullable: true,
    format: 'date-time',
  })
  paymentDueAt!: string | null;
  @ApiProperty({
    description: '취소되지 않은 상세의 결제 금액(원). 미완료 수집 중에는 null.',
    type: Number,
    nullable: true,
  })
  totalAmount!: number | null;
  @ApiProperty({
    enum: ORDER_STATUSES,
    description:
      'notPaid 결제 대기, PAID 결제 완료, SUBMITTING 디버 접수 중, SUBMITTING_FAILED 자동 재시도 중 실패, ACCEPTED 디버 접수 완료, SUBMISSION_FAILED 자동 재시도가 끝난 최종 실패. 접수 성공은 ACCEPTED만 안내합니다.',
  })
  status!: OrderStatus;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '연결된 call_sessions.call_session_seq. 통화 없는 관리자 주문은 null.',
  })
  callSessionSeq!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '디버 접수 참고번호. 접수 성공 전에는 null.',
  })
  parcelNo!: string | null;
}

export class ParcelConversionDto {
  @ApiProperty() draftSeq!: number;
  @ApiProperty() orderParcelSeq!: number;
}

export class OrderIntakeResponseDto {
  @ApiProperty() callSessionSeq!: number;
  @ApiProperty() intakeVersion!: number;
  @ApiProperty({
    enum: [
      'COLLECTING',
      'WAITING_AI',
      'WAITING_PBX',
      'FINALIZING',
      'FAILED',
      'NO_ORDER',
      'FINALIZED',
    ],
  })
  status!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  endedAt!: Date | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  completionReceivedAt!: Date | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  finalizedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) errorCode!: string | null;
  @ApiProperty({ nullable: true, type: Number }) orderSeq!: number | null;
  @ApiProperty({ type: () => ParcelConversionDto, isArray: true })
  parcelMappings!: ParcelConversionDto[];
  @ApiProperty({
    type: () => OrderResultDto,
    nullable: true,
    description:
      '현재 주문·결제 상태. 삭제·만료되면 null이며 변환 번호는 보존.',
  })
  order!: OrderResultDto | null;
}
