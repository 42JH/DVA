import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ORDER_STATUSES, type OrderStatus } from '../orders.types';

export class OrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '고객 번호. AI는 통화 발신번호와 일치하는 고객만 조회할 수 있습니다.',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq?: number;

  @ApiPropertyOptional({
    description: '주문 생성 시각의 시작 경계(포함). Z 또는 시간대 오프셋 필수.',
    format: 'date-time',
    example: '2026-10-27T00:00:00+09:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    description: '주문 생성 시각의 종료 경계(미포함). from보다 늦어야 합니다.',
    format: 'date-time',
    example: '2026-10-28T00:00:00+09:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;

  @ApiPropertyOptional({
    description:
      '주문 상태: COLLECTING 수집 중, notPaid 결제 대기, PAID 결제 완료, SUBMITTING 디버 접수 중, SUBMITTING_FAILED 자동 재시도 중 실패, ACCEPTED 디버 접수 완료, SUBMISSION_FAILED 자동 재시도가 끝난 최종 실패, CANCELLED 취소됨.',
    enum: ORDER_STATUSES,
    example: 'COLLECTING',
  })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({
    description: '수령인 이름 부분 검색. 앞뒤 공백 제거, 대소문자 구분 없음.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Matches(/\S/u)
  recipientName?: string;

  @ApiPropertyOptional({ description: '조회 개수.', default: 20, minimum: 1, maximum: 100 })
  declare limit: number;

  @ApiPropertyOptional({ description: '건너뛸 주문 수. 0부터 시작합니다.', default: 0, minimum: 0 })
  declare offset: number;
}

export class OrderIdParamsDto {
  @ApiProperty({
    description: '주문 번호(orderSeq). 디버 접수 참고값(parcelNo)과 다릅니다.',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
