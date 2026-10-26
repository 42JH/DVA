import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiHeader,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CookieOptions, Response } from 'express';
import { Environment } from '../config/environment';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AuthService } from './auth.service';
import { AuthRequest, PublicAuth, SESSION_COOKIE } from './auth.guard';
import { LoginDto } from './dto/auth-request.dto';
import { LoginEnvelopeDto } from './dto/auth-response.dto';
export function cookieOptions(production: boolean): CookieOptions {
  return { httpOnly: true, secure: production, sameSite: 'lax', path: '/api' };
}
@ApiTags('Auth')
@ApiCookieAuth('adminSession')
@ApiHeader({
  name: 'X-CSRF-Protection',
  description: '변경 요청에 1 전달. 허용 Origin 필수.',
  required: false,
})
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
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
  @ApiOperation({ security: [] })
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({
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
}
