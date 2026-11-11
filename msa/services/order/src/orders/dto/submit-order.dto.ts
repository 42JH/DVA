import { ApiProperty } from '@nestjs/swagger';
import { ORDER_STATUSES, type OrderStatus } from '../orders.types';

export class SubmittedOrderDto {
  @ApiProperty({
    description:
      'notPaid: 결제 대기, PAID: 결제 완료, SUBMITTING: 디버 접수중, SUBMITTING_FAILED: 자동 재시도 중 실패, ACCEPTED: 디버 접수 완료, SUBMISSION_FAILED: 자동 재시도가 끝난 최종 실패.',
    enum: ORDER_STATUSES,
  })
  status!: OrderStatus;
}
