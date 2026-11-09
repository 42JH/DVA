import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { ORDER_STATUSES, OrderStatus } from '../orders.types';

export class SubmitOrderDto {
  @ApiProperty({
    description:
      '고객이 최종 확인한 주문의 version. 최초 접수에 검사하며, 이미 접수한 주문은 현재 상태만 반환합니다.',
    minimum: 1,
    maximum: 2147483647,
    example: 4,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;
}

export class SubmittedOrderDto {
  @ApiProperty({
    description:
      'notPaid: 결제 대기, PAID: 결제 완료, SUBMITTING: 디버 접수중, SUBMITTING_FAILED: 자동 재시도 중 실패, ACCEPTED: 디버 접수 완료, SUBMISSION_FAILED: 자동 재시도가 끝난 최종 실패.',
    enum: ORDER_STATUSES,
  })
  status!: OrderStatus;
}
