import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ADMIN_ROLES, ADMIN_STATUSES, AdminRole, AdminStatus } from '../admins.types';
export class AdminQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_ROLES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;
  @ApiPropertyOptional({ enum: ADMIN_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_STATUSES)
  status?: AdminStatus;
}
export class UpdateAdminDto {
  @ApiPropertyOptional({ enum: ADMIN_ROLES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_ROLES)
  role?: AdminRole;
  @ApiPropertyOptional({ enum: ADMIN_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ADMIN_STATUSES)
  status?: AdminStatus;
}
