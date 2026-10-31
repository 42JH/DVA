import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';
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
export class UpdateAdminRoleDto {
  @ApiProperty({
    description: '변경할 권한. SYSTEM_ADMIN의 권한은 변경할 수 없습니다.',
    enum: ASSIGNABLE_ADMIN_ROLES,
    example: 'SUPERVISOR',
  })
  @IsIn(ASSIGNABLE_ADMIN_ROLES)
  role!: AssignableAdminRole;
}
