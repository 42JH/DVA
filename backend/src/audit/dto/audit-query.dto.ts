import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AUDIT_RESULTS, AuditResult, AUDIT_ACTOR_TYPES, AuditActorType } from '../audit.types';

function integer({ value }: TransformFnParams): unknown {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: AUDIT_ACTOR_TYPES,
    description: '담당 주체: AI, SYSTEM, ADMIN(운영자).',
  })
  @IsOptional()
  @IsIn(AUDIT_ACTOR_TYPES)
  actorType?: AuditActorType;
  @ApiPropertyOptional({
    description: '작업한 관리자 번호(adminUserSeq).',
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  actorSeq?: number;

  @ApiPropertyOptional({
    description: '작업 코드. 정확히 일치하는 기록 조회.',
    example: 'ADMIN_ACCESS_CHANGED',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  action?: string;

  @ApiPropertyOptional({
    description: '대상 유형. 정확히 일치하는 기록 조회.',
    example: 'ADMIN_USER',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  targetType?: string;

  @ApiPropertyOptional({
    description: '작업 대상 번호(targetType에 해당하는 식별자).',
    type: Number,
    minimum: 1,
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  targetSeq?: number;

  @ApiPropertyOptional({
    description: '처리 결과. SUCCESS: 성공, DENIED: 접근 거절, FAILED: 실패.',
    enum: AUDIT_RESULTS,
  })
  @IsOptional()
  @IsIn(AUDIT_RESULTS)
  result?: AuditResult;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: '시작 시각 포함. Z 또는 시간대 오프셋 필수.',
    example: '2026-10-26T00:00:00+09:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: '종료 시각 미포함. Z 또는 시간대 오프셋 필수.',
    example: '2026-10-27T00:00:00+09:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;
}
