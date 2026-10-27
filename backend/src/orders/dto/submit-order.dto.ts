import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class SubmitOrderDto {
  @ApiProperty({
    description: '고객이 최종 확인한 주문의 version. 상세 조회 후 그대로 전달합니다.',
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
      'ACCEPTED: 접수 확인, SUBMITTING: 처리 중, AUTH_FAILED: 디버 인증 실패, REVIEW_REQUIRED: 결과 확인 필요.',
    enum: ['ACCEPTED', 'SUBMITTING', 'AUTH_FAILED', 'REVIEW_REQUIRED'],
  })
  status!: 'ACCEPTED' | 'SUBMITTING' | 'AUTH_FAILED' | 'REVIEW_REQUIRED';
}
