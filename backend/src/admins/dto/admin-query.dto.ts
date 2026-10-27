import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ADMIN_ROLES, ADMIN_STATUSES, AdminRole, AdminStatus } from '../admins.types';
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
    description: '변경할 권한. role과 status 중 하나 이상 필요합니다.',
    enum: ADMIN_ROLES,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;
  @ApiPropertyOptional({
    description: '가입 승인 시 ACTIVE 지정. PENDING → ACTIVE만 가능합니다.',
    enum: ADMIN_STATUSES,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_STATUSES)
  status?: AdminStatus;
}
