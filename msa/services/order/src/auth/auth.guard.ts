import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AdminPublic, AdminRole } from '../admins/admins.types';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import type { AuthenticationType } from '../observability/security-events';
import { AuthService } from './auth.service';
import { MVP_AI_ACCESS } from './mvp-ai-access';

export const PublicAuth = () => SetMetadata('auth:public', true);
export const Roles = (...roles: AdminRole[]) => SetMetadata('auth:roles', roles);
export type AuthRequest = Request & {
  requestId: string;
  admin?: AdminPublic;
  securityAuthType?: AuthenticationType;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('auth:internal-customer', targets)) {
      const actual = Buffer.from(request.get('Authorization') ?? '');
      const expected = Buffer.from(
        'Bearer ' + this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      );
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new ApiException(403, 'FORBIDDEN', '서비스 인증이 필요합니다.');
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>('auth:public', targets)) return true;
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('dva_session='));
    if (this.reflector.get<boolean>(MVP_AI_ACCESS, context.getHandler()) && cookies.length === 0)
      return true;
    const token = cookies.length === 1 ? cookies[0].slice('dva_session='.length) : '';
    request.securityAuthType = 'admin_session';
    request.admin = await this.auth.authenticate(token);
    delete request.securityAuthType;
    const roles = this.reflector.getAllAndOverride<AdminRole[]>('auth:roles', targets);
    if (roles && !roles.includes(request.admin.role))
      throw new ApiException(403, 'FORBIDDEN', '접근 권한이 없습니다.');
    return true;
  }
}
