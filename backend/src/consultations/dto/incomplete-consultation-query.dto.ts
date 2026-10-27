import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class IncompleteConsultationQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '기존 provider_call_id와 정확히 일치하는 통화' })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  providerCallId?: string;
  @ApiPropertyOptional({ format: 'date-time', description: '종료 시각 시작(포함), 타임존 필수' })
  @IsOptional()
  @IsString()
  from?: string;
  @ApiPropertyOptional({ format: 'date-time', description: '종료 시각 끝(미포함), 타임존 필수' })
  @IsOptional()
  @IsString()
  to?: string;
}

export class IncompleteConsultationIdDto {
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
