import { AuditOperation } from '../audit/audit-operation';
import { Body, Controller, Get, HttpCode, Param, Patch, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AdminsService } from '../admins/admins.service';
import { AdminQueryDto, UpdateAdminDto } from '../admins/dto/admin-query.dto';
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
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@Roles('SYSTEM_ADMIN')
@Controller('admins')
export class AdminAccessController {
  constructor(
    private readonly admins: AdminsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  @Get()
  @ApiOkResponse({ type: AdminListDto })
  async list(@Query() query: AdminQueryDto) {
    return new ListResponse(await this.admins.list(query), query.limit);
  }
  @AuditOperation({ action: 'ADMIN_ACCESS_CHANGED', targetType: 'ADMIN_USER', target: 'id' })
  @Patch(':id')
  @HttpCode(204)
  @ApiParam({ name: 'id', schema: { type: 'integer', minimum: 1 } })
  @ApiNoContentResponse()
  update(@Param('id') id: string, @Body() input: UpdateAdminDto, @Req() request: AuthRequest) {
    return this.auth.updateAdmin(request.sessionToken, adminId(id), input, request.requestId);
  }
  @AuditOperation({ action: 'ADMIN_PASSWORD_CHANGED', targetType: 'ADMIN_USER', target: 'id' })
  @Patch(':id/password')
  @HttpCode(204)
  @ApiParam({ name: 'id', schema: { type: 'integer', minimum: 1 } })
  @ApiNoContentResponse()
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
