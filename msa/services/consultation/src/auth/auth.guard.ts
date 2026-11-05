import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AdminPublic, AdminRole } from '../admins/admins.types';
import { ApiException } from '../common/errors/api.exception';
import { AuthService } from './auth.service';
export const SESSION_COOKIE = 'dva_session';
export const PublicAuth = () => SetMetadata('auth:public', true);
export const Roles = (...roles: AdminRole[]) =>
  SetMetadata('auth:roles', roles);
export type AuthRequest = Request & {
  requestId: string;
  admin: AdminPublic;
  sessionToken: string;
};
export function readSessionToken(request: Request): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0].slice(SESSION_COOKIE.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const targets = [context.getHandler(), context.getClass()];
    if (request.path.replace(/\/$/, '') === '/webhooks/pbx/call-ended')
      return true;
    if (this.reflector.getAllAndOverride<boolean>('auth:public', targets))
      return true;
    request.sessionToken = readSessionToken(request) ?? '';
    request.admin = await this.auth.authenticate(request.sessionToken);
    const roles = this.reflector.getAllAndOverride<AdminRole[]>(
      'auth:roles',
      targets,
    );
    if (roles && !roles.includes(request.admin.role))
      throw new ApiException(403, 'FORBIDDEN', '접근 권한이 없습니다.');
    return true;
  }
}
