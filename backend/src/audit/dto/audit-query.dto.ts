import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { AUDIT_RESULTS, AuditResult } from '../audit.types';

function integer({ value }: TransformFnParams): unknown {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

export class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1 })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  actorSeq?: number;

  @ApiPropertyOptional({ example: 'ADMIN_ACCESS_CHANGED' })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  action?: string;

  @ApiPropertyOptional({ example: 'ADMIN_USER' })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  targetType?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1 })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  targetSeq?: number;

  @ApiPropertyOptional({ enum: AUDIT_RESULTS })
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
