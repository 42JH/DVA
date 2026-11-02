import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { HANDOFF_STATUSES, HandoffStatus } from '../consultations.types';
import { ORDER_STATUSES, OrderStatus } from '../../orders/orders.types';

export class CallQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: '현재 연결 고객 이름·발신번호 부분 검색. %·_는 일반 문자.',
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\0]*$/u)
  q?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: '확인된 불만 여부. false는 미판정·미수신을 포함하지 않습니다.',
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  hasComplaint?: boolean;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '분석에 기록된 실제 사용 페르소나 버전의 DB 번호.',
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  aiPersonaVersionSeq?: number;

  @ApiPropertyOptional({
    enum: ORDER_STATUSES,
    description: '연결 주문의 현재 결제·접수 상태로 검색.',
  })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  orderStatus?: OrderStatus;
  @ApiPropertyOptional({
    description: '연결된 주문 번호(orderSeq).',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    example: 10,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderSeq?: number;

  @ApiPropertyOptional({
    description: '저장된 발신번호와 정확히 일치하는 통화. 국제번호는 앞의 +를 포함합니다.',
    example: '01012345678',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]+$/)
  callerPhoneNumber?: string;

  @ApiPropertyOptional({
    description:
      '표시 시작 시각(PBX 시작 → AI 시작 → 수신)의 시작 경계(포함). Z 또는 시간대 오프셋 필수.',
    format: 'date-time',
    example: '2026-10-28T00:00:00+09:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    description:
      '표시 시작 시각(PBX 시작 → AI 시작 → 수신)의 종료 경계(미포함). from보다 늦어야 합니다.',
    format: 'date-time',
    example: '2026-10-29T00:00:00+09:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;

  @ApiPropertyOptional({
    description: '저장된 종료 사유와 정확히 일치하는 통화. 종료 사유 코드는 미확정입니다.',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  endReason?: string;

  @ApiPropertyOptional({
    description: '상담원 연결 상태. REQUESTED 요청, CONNECTED 연결 확인, FAILED 실패 확인.',
    enum: HANDOFF_STATUSES,
    example: 'CONNECTED',
  })
  @IsOptional()
  @IsIn(HANDOFF_STATUSES)
  handoffStatus?: HandoffStatus;

  @ApiPropertyOptional({ description: '조회 개수.', default: 20, minimum: 1, maximum: 100 })
  declare limit: number;

  @ApiPropertyOptional({ description: '건너뛸 통화 수.', default: 0, minimum: 0 })
  declare offset: number;
}
