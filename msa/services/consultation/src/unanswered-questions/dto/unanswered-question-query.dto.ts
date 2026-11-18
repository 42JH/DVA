import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import {
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
import {
  UNANSWERED_QUESTION_REASONS,
  UnansweredQuestionReason,
} from '../unanswered-question.types';

const reasonFilters = [...UNANSWERED_QUESTION_REASONS, 'UNCLASSIFIED'] as const;

const integer = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class UnansweredQuestionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '선택한 질문 번호.',
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  unansweredQuestionSeq?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '질문이 발생한 통화 번호.',
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  callSessionSeq?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '통화 분석에 기록된 실제 사용 페르소나 버전.',
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  aiPersonaVersionSeq?: number;

  @ApiPropertyOptional({
    enum: ['OPEN', 'REGISTERED', 'ALL'],
    default: 'OPEN',
    description:
      '기본 미처리. ALL은 OPEN·REGISTERED를 함께 조회하며 삭제한 질문은 제외합니다.',
  })
  @IsIn(['OPEN', 'REGISTERED', 'ALL'])
  status: 'OPEN' | 'REGISTERED' | 'ALL' = 'OPEN';

  @ApiPropertyOptional({
    enum: reasonFilters,
    description:
      '생략은 전체 사유. UNCLASSIFIED는 사유가 null인 과거·미분류 질문만 조회합니다.',
  })
  @IsOptional()
  @IsIn(reasonFilters)
  reason?: UnansweredQuestionReason | 'UNCLASSIFIED';

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      '질문·현재 고객 이름·발신번호 부분 검색. 앞뒤 공백 제거 후 비어 있으면 전체 조회. %·_는 일반 문자.',
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\0]*$/u)
  q?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      '통화 시작 시각의 시작 경계(포함). 시간대 필수이며 to와 함께 지정합니다.',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: '통화 시작 시각의 종료 경계(미포함). from보다 늦어야 합니다.',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;
}
