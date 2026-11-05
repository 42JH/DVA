import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CUSTOMER_STATUSES, type CustomerStatus } from '../customers.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '이름 부분 검색. 앞뒤 공백 제거.' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: '전화번호 정확히 일치 검색.', pattern: '^[0-9]+$' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[0-9]+$/)
  phoneNumber?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(CUSTOMER_STATUSES)
  status?: CustomerStatus;
}

export class CustomerIdParamsDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647, description: 'customerSeq' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
