import { Body, Controller, Get, HttpCode, Param, Patch, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminsService } from '../admins/admins.service';
import { AdminQueryDto, UpdateAdminDto } from '../admins/dto/admin-query.dto';
import { ListResponse } from '../common/pagination';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ApiException } from '../common/errors/api.exception';
import { Environment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthRequest, Roles } from './auth.guard';
import { AdminListDto } from './dto/auth-response.dto';
function adminId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2147483647)
    throw new ApiException(400, 'INVALID_REQUEST', '관리자 식별자를 확인해 주세요.');
  return Number(value);
}
@ApiTags('Admins')
@ApiCookieAuth('adminSession')
@ApiHeader({
  name: 'X-CSRF-Protection',
  description: '변경 요청에 1 전달. 허용 Origin 필수.',
  required: false,
})
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
  @Patch(':id')
  @HttpCode(204)
  @ApiParam({ name: 'id', schema: { type: 'integer', minimum: 1 } })
  @ApiNoContentResponse()
  update(@Param('id') id: string, @Body() input: UpdateAdminDto, @Req() request: AuthRequest) {
    return this.auth.updateAdmin(request.sessionToken, adminId(id), input, request.requestId);
  }
}
