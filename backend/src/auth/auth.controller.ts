import { AuditOperation } from '../audit/audit-operation';
import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CookieOptions, Response } from 'express';
import { Environment } from '../config/environment';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AuthService } from './auth.service';
import { AuthRequest, PublicAuth, SESSION_COOKIE } from './auth.guard';
import { ChangePasswordDto, LoginDto, SignupDto } from './dto/auth-request.dto';
import { LoginEnvelopeDto, MeEnvelopeDto } from './dto/auth-response.dto';
import { LimitAuthRequests } from './auth-limits.guard';
export function cookieOptions(production: boolean): CookieOptions {
  return { httpOnly: true, secure: production, sameSite: 'lax', path: '/api' };
}
@ApiTags('Auth')
@ApiCookieAuth('adminSession')
@ApiResponse({ status: 400, description: '요청 형식 오류.', type: ErrorResponseDto })
@ApiResponse({
  status: 401,
  description: '로그인 정보 또는 세션이 유효하지 않음.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 403, description: '허용되지 않은 Origin.', type: ErrorResponseDto })
@ApiResponse({
  status: 429,
  description: '인증 요청 제한. Retry-After 초 이후 다시 시도합니다.',
  type: ErrorResponseDto,
  headers: { 'Retry-After': { description: '재시도까지 남은 초', schema: { type: 'integer' } } },
})
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  private options() {
    return cookieOptions(this.config.get('NODE_ENV', { infer: true }) === 'production');
  }
  @PublicAuth()
  @ApiOperation({
    summary: '로그인',
    description:
      'ACTIVE 관리자만 로그인할 수 있습니다. 올바른 비밀번호를 입력한 INACTIVE·PENDING 계정은 각각 403 ACCOUNT_INACTIVE·ACCOUNT_PENDING을 반환하며 세션을 발급하지 않습니다. 세션 쿠키는 로그인 후 9시간 동안 유효합니다.',
    security: [],
  })
  @AuditOperation({ action: 'ADMIN_LOGIN', targetType: 'ADMIN_USER', target: 'none' })
  @Post('login')
  @LimitAuthRequests('login')
  @HttpCode(200)
  @ApiResponse({
    status: 403,
    description:
      'ACCOUNT_INACTIVE: 비활성화된 계정입니다. ACCOUNT_PENDING: 승인 대기중입니다. FORBIDDEN: 허용되지 않은 Origin.',
    type: ErrorResponseDto,
  })
  @ApiOkResponse({
    description: '로그인 성공. 세션 쿠키 발급 및 만료 시각 반환.',
    type: LoginEnvelopeDto,
    headers: {
      'Set-Cookie': { description: 'HttpOnly 관리자 세션 쿠키', schema: { type: 'string' } },
    },
  })
  async login(
    @Body() input: LoginDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(input, request.requestId, request.sessionToken);
    response.cookie(SESSION_COOKIE, result.token, { ...this.options(), expires: result.expiresAt });
    return { expiresAt: result.expiresAt };
  }
  @PublicAuth()
  @ApiOperation({
    summary: '관리자 가입 신청',
    description:
      'OPERATOR 권한·PENDING 상태로 등록합니다. SYSTEM_ADMIN의 승인 후 로그인할 수 있습니다.',
    security: [],
  })
  @AuditOperation({ action: 'ADMIN_SIGNUP', targetType: 'ADMIN_USER', target: 'none' })
  @Post('signup')
  @LimitAuthRequests('signup')
  @HttpCode(204)
  @ApiNoContentResponse({ description: '가입 신청 완료.' })
  @ApiResponse({ status: 409, description: '이미 사용 중인 로그인 ID.', type: ErrorResponseDto })
  signup(@Body() input: SignupDto, @Req() request: AuthRequest) {
    return this.auth.signup(input, request.requestId);
  }
  @PublicAuth()
  @ApiOperation({
    summary: '로그아웃',
    description: '현재 세션과 쿠키를 삭제합니다. 유효한 세션이 없어도 성공합니다.',
    security: [],
  })
  @AuditOperation({ action: 'ADMIN_LOGOUT', targetType: 'ADMIN_USER', target: 'none' })
  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse({ description: '로그아웃 완료.' })
  @ApiResponse({
    status: 503,
    description: '세션 삭제 실패. 다시 시도해야 합니다.',
    type: ErrorResponseDto,
  })
  async logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request.sessionToken, request.requestId);
    response.clearCookie(SESSION_COOKIE, this.options());
  }
  @Get('me')
  @ApiOperation({
    summary: '내 정보 조회',
    description: '로그인한 관리자의 이름·권한·상태를 조회합니다.',
  })
  @ApiOkResponse({ description: '현재 관리자 정보.', type: MeEnvelopeDto })
  me(@Req() request: AuthRequest) {
    const { adminUserSeq, loginId, name, role, status } = request.admin;
    return { adminUserSeq, loginId, name, role, status };
  }
  @AuditOperation({ action: 'ADMIN_PASSWORD_CHANGED', targetType: 'ADMIN_USER', target: 'actor' })
  @Patch('password')
  @HttpCode(204)
  @ApiOperation({
    summary: '내 비밀번호 변경',
    description:
      '현재 비밀번호를 확인한 뒤 변경합니다. 본인의 모든 세션이 종료되어 다시 로그인해야 합니다.',
  })
  @ApiNoContentResponse({ description: '비밀번호 변경 및 전체 세션 종료.' })
  @ApiResponse({
    status: 422,
    description: '현재 비밀번호 불일치 또는 새 비밀번호 조건 오류.',
    type: ErrorResponseDto,
  })
  async password(
    @Body() input: ChangePasswordDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.changePassword(request.sessionToken, input, request.requestId);
    response.clearCookie(SESSION_COOKIE, this.options());
  }
}
