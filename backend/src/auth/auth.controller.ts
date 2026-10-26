import { Controller } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CookieOptions } from 'express';
import { Environment } from '../config/environment';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AuthService } from './auth.service';
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
}
