import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  ADMIN_ROLES,
  ADMIN_STATUSES,
  ASSIGNABLE_ADMIN_ROLES,
  AdminRole,
  AdminStatus,
  AssignableAdminRole,
} from '../admins.types';
export class AdminQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      '관리자 이름·로그인 아이디 부분 검색. 대소문자 구분 없이 앞뒤 공백 제거 후 최대 100자. 빈 검색어는 검색하지 않으며 %, _는 일반 문자입니다. 실제 로그인의 아이디 일치 규칙은 유지합니다.',
    maxLength: 100,
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  @Matches(/^[^\u0000]*$/u)
  q?: string;

  @ApiPropertyOptional({ description: '관리자 권한 필터.', enum: ADMIN_ROLES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;
  @ApiPropertyOptional({ description: '가입 승인 상태 필터.', enum: ADMIN_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_STATUSES)
  status?: AdminStatus;
}
export class UpdateAdminDto {
  @ApiPropertyOptional({
    description:
      '변경할 권한. OPERATOR·SUPERVISOR만 지정하며 role과 status 중 하나 이상 필요합니다.',
    enum: ASSIGNABLE_ADMIN_ROLES,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ASSIGNABLE_ADMIN_ROLES)
  role?: AssignableAdminRole;
  @ApiPropertyOptional({
    description:
      'PENDING → ACTIVE 가입 승인, OPERATOR·SUPERVISOR의 ACTIVE ↔ INACTIVE 전환. 같은 상태나 PENDING으로의 변경은 불가합니다.',
    enum: ADMIN_STATUSES,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_STATUSES)
  status?: AdminStatus;
}
