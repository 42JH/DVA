import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthRequest } from '../auth/auth.guard';
import { Roles } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { DepartmentsService } from './departments.service';

@ApiTags('departments')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller()
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}
  @Get('companies/:id/departments')
  @ApiOperation({ summary: '기업 부서 목록' })
  list(@Param() params: OrganizationIdParamsDto, @Query() query: PaginationQueryDto) {
    return this.departments.list(params.id, query);
  }
  @Post('companies/:id/departments')
  @AuditOperation({ action: 'DEPARTMENT_CREATED', targetType: 'ORGANIZATION', target: 'id' })
  @ApiOperation({ summary: '기업 부서 등록' })
  create(
    @Param() params: OrganizationIdParamsDto,
    @Body() input: CreateDepartmentDto,
    @Req() request: AuthRequest,
  ) {
    return this.departments.create(
      params.id,
      input,
      request.admin!.adminUserSeq,
      request.requestId,
    );
  }
  @Patch('departments/:id')
  @HttpCode(204)
  @AuditOperation({ action: 'DEPARTMENT_UPDATED', targetType: 'DEPARTMENT', target: 'id' })
  @ApiOperation({ summary: '부서 이름·그룹결제 설정 변경' })
  update(
    @Param() params: OrganizationIdParamsDto,
    @Body() input: UpdateDepartmentDto,
    @Req() request: AuthRequest,
  ) {
    return this.departments.update(
      params.id,
      input,
      request.admin!.adminUserSeq,
      request.requestId,
    );
  }
}
