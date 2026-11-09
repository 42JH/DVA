import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsString, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ORGANIZATION_STATUSES, OrganizationStatus } from '../organizations.types';

export class ListOrganizationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '기업명 부분 검색. 공백만 있으면 전체 조회합니다.' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: TransformFnParams) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: ORGANIZATION_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ORGANIZATION_STATUSES)
  status?: OrganizationStatus;
}
