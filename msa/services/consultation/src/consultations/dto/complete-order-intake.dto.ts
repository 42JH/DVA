import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CompleteOrderIntakeDto {
  @ApiProperty({
    minimum: 1,
    maximum: 2147483647,
    description:
      '마지막 초안 저장 응답의 intakeVersion. 저장 요청을 모두 await한 후 전달.',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedIntakeVersion!: number;

  @ApiPropertyOptional({
    enum: ['billing', 'credit', 'groupBilling'],
    description: 'READY가 있으면 필수. 전체 READY 상세에 적용할 결제수단.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(['billing', 'credit', 'groupBilling'])
  paymentMethodType?: 'billing' | 'credit' | 'groupBilling';

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'AI 확인 수거 시각. 영업시간 제한 없이 저장하고 기존 결제 시각 보정 정책 적용.',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  pickupRequestedAt?: string | null;
}
