import { AuditOperation } from '../audit/audit-operation';
import { Body, Controller, Get, HttpCode, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AdminsService } from '../admins/admins.service';
import { AdminQueryDto, UpdateAdminDto, UpdateAdminRoleDto } from '../admins/dto/admin-query.dto';
import { ListResponse } from '../common/pagination';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ApiException } from '../common/errors/api.exception';
import { Environment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthRequest, Roles, SESSION_COOKIE } from './auth.guard';
import { cookieOptions } from './auth.controller';
import { ResetPasswordDto } from './dto/auth-request.dto';
import { AdminListDto } from './dto/auth-response.dto';
function adminId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647)
    throw new ApiException(400, 'INVALID_REQUEST', '관리자 식별자를 확인해 주세요.');
  return Number(value);
}
@ApiTags('Admins')
@ApiCookieAuth('adminSession')
@ApiResponse({
  status: 400,
  description: '요청 형식 오류 또는 변경 항목 누락.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '로그인 세션이 없거나 만료됨.', type: ErrorResponseDto })
@ApiResponse({
  status: 403,
  description: 'SYSTEM_ADMIN 권한이 없거나 최상위 관리자 권한 변경 시도, 허용되지 않은 Origin.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 404, description: '대상 관리자가 없음.', type: ErrorResponseDto })
@ApiResponse({
  status: 409,
  description: '허용되지 않은 계정 상태 변경.',
  type: ErrorResponseDto,
})
@Roles('SYSTEM_ADMIN')
@Controller('admins')
export class AdminAccessController {
  constructor(
    private readonly admins: AdminsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  @Get()
  @ApiOperation({
    summary: '관리자 목록 조회',
    description: 'SYSTEM_ADMIN 전용. 권한·상태로 필터링하며 관리자 번호 내림차순으로 조회합니다.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '조회 개수. 기본 20, 최대 100.' })
  @ApiQuery({ name: 'offset', required: false, description: '건너뛸 개수. 기본 0.' })
  @ApiOkResponse({ description: '관리자 목록과 다음 페이지 여부.', type: AdminListDto })
  async list(@Query() query: AdminQueryDto) {
    return new ListResponse(await this.admins.list(query), query.limit);
  }
  @AuditOperation({ action: 'ADMIN_ACCESS_CHANGED', targetType: 'ADMIN_USER', target: 'id' })
  @Patch(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: '관리자 권한 변경·가입 승인',
    description:
      'SYSTEM_ADMIN 전용. OPERATOR·SUPERVISOR의 권한 변경 또는 PENDING 계정의 ACTIVE 승인을 처리합니다. SYSTEM_ADMIN의 권한은 변경할 수 없습니다.',
  })
  @ApiParam({
    name: 'id',
    description: '대상 관리자 번호(adminUserSeq).',
    schema: { type: 'integer', minimum: 1 },
  })
  @ApiNoContentResponse({ description: '권한 변경 또는 가입 승인 완료.' })
  update(@Param('id') id: string, @Body() input: UpdateAdminDto, @Req() request: AuthRequest) {
    return this.auth.updateAdmin(request.sessionToken, adminId(id), input, request.requestId);
  }
  @AuditOperation({ action: 'ADMIN_ACCESS_CHANGED', targetType: 'ADMIN_USER', target: 'id' })
  @Patch(':id/role')
  @HttpCode(204)
  @ApiOperation({
    summary: '관리자 권한 변경',
    description:
      'SYSTEM_ADMIN 전용. OPERATOR ↔ SUPERVISOR만 변경하며 계정 상태는 유지합니다. 변경된 권한은 기존 세션의 다음 요청부터 적용됩니다.',
  })
  @ApiParam({
    name: 'id',
    description: '대상 관리자 번호(adminUserSeq). SYSTEM_ADMIN은 변경 불가.',
    schema: { type: 'integer', minimum: 1 },
  })
  @ApiNoContentResponse({ description: '권한 변경 완료. 응답 본문 없음.' })
  role(@Param('id') id: string, @Body() input: UpdateAdminRoleDto, @Req() request: AuthRequest) {
    return this.auth.updateAdmin(request.sessionToken, adminId(id), input, request.requestId);
  }
  @AuditOperation({ action: 'ADMIN_PASSWORD_CHANGED', targetType: 'ADMIN_USER', target: 'id' })
  @Patch(':id/password')
  @HttpCode(204)
  @ApiOperation({
    summary: '관리자 비밀번호 초기화',
    description:
      'SYSTEM_ADMIN 전용. 입력한 새 비밀번호로 변경하고 대상 관리자의 모든 세션을 종료합니다.',
  })
  @ApiParam({
    name: 'id',
    description: '대상 관리자 번호(adminUserSeq).',
    schema: { type: 'integer', minimum: 1 },
  })
  @ApiNoContentResponse({ description: '비밀번호 초기화 및 대상 관리자의 전체 세션 종료.' })
  async password(
    @Param('id') id: string,
    @Body() input: ResetPasswordDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      await this.auth.resetPassword(
        request.sessionToken,
        adminId(id),
        input.newPassword,
        request.requestId,
      )
    )
      response.clearCookie(
        SESSION_COOKIE,
        cookieOptions(this.config.get('NODE_ENV', { infer: true }) === 'production'),
      );
  }
}
