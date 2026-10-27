import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
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
