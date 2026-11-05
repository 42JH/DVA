import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { MEMBER_STATUSES, type MemberStatus } from '../members.types';

export class MemberIdParamsDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '경로에 따라 organizationSeq 또는 membershipSeq',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}

export class ListMembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MEMBER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_STATUSES)
  status?: MemberStatus;
}
