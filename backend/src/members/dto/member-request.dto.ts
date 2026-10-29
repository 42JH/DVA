import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { MEMBER_ROLES, MEMBER_STATUSES, MemberRole, MemberStatus } from '../members.types';

export class MemberIdParamsDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '경로에 따라 organizationSeq 또는 membershipSeq',
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
export class CreateMemberDto {
  @ApiProperty({ description: '같은 기업에 속한 필수 부서 번호.', minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  departmentSeq!: number;
  @ApiProperty({
    description: '기업 내 고유 사번. 선행 0과 대소문자를 보존하며 등록 후 변경 불가.',
  })
  @Transform(({ value }: TransformFnParams) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^[^\u0000]+$/)
  employeeNo!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq!: number;

  @ApiProperty({
    enum: MEMBER_ROLES,
    description: 'MEMBER 일반 구성원 / ORG_ADMIN 대표자 표시. 관리자 웹 권한을 부여하지 않습니다.',
  })
  @IsIn(MEMBER_ROLES)
  role!: MemberRole;
}
export class UpdateMemberDto {
  @ApiPropertyOptional({
    description: '같은 기업 내 이동할 부서 번호.',
    minimum: 1,
    maximum: 2147483647,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  departmentSeq?: number;
  @ApiPropertyOptional({ enum: MEMBER_ROLES, description: '대표자 여부 표시. 별도 권한 없음.' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_ROLES)
  role?: MemberRole;

  @ApiPropertyOptional({ enum: MEMBER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_STATUSES)
  status?: MemberStatus;
}
export class ListMembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MEMBER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_STATUSES)
  status?: MemberStatus;
}
