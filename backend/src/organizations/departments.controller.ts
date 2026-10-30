import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthRequest } from '../auth/auth.guard';
import { Roles } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import {
  CreateDepartmentDto,
  DepartmentEnvelopeDto,
  DepartmentsEnvelopeDto,
  UpdateDepartmentDto,
} from './dto/department.dto';
import { DepartmentsService } from './departments.service';
import { OrganizationDeletionService } from './organization-deletion.service';
import { ErrorResponseDto } from '../common/dto/api-response.dto';

@ApiTags('departments')
@ApiCookieAuth('adminSession')
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller()
export class DepartmentsController {
  constructor(
    private readonly departments: DepartmentsService,
    private readonly deletion: OrganizationDeletionService,
  ) {}
  @Get('companies/:id/departments')
  @ApiOperation({ summary: '기업 부서 목록' })
  @ApiOkResponse({ type: DepartmentsEnvelopeDto })
  list(@Param() params: OrganizationIdParamsDto, @Query() query: PaginationQueryDto) {
    return this.departments.list(params.id, query);
  }
  @Post('companies/:id/departments')
  @AuditOperation({ action: 'DEPARTMENT_CREATED', targetType: 'ORGANIZATION', target: 'id' })
  @ApiOperation({ summary: '기업 부서 등록' })
  @ApiCreatedResponse({ type: DepartmentEnvelopeDto })
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
  @ApiNoContentResponse({ description: '저장 완료. 응답 본문 없음.' })
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

  @Delete('departments/:id')
  @HttpCode(204)
  @AuditOperation({ action: 'DEPARTMENT_DELETED', targetType: 'DEPARTMENT', target: 'id' })
  @ApiOperation({
    summary: '부서 삭제',
    description:
      '소속 사원의 기업·부서 소속을 해제하고 해당 부서 PIN만 삭제합니다. 개인 회원·기업 공용 PIN·업무 이력을 보존합니다. 미배정 부서명 PIN이 있으면 409입니다.',
  })
  @ApiNoContentResponse({ description: '삭제 완료. 응답 본문 없음.' })
  remove(@Param() params: OrganizationIdParamsDto, @Req() request: AuthRequest) {
    return this.deletion.remove(params.id, true, request.admin!.adminUserSeq, request.requestId);
  }
}
