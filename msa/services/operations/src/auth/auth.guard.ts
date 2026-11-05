import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Environment } from '../config/environment';
import { AdminPublic, AdminRole } from '../admins/admins.types';
import { ApiException } from '../common/errors/api.exception';
import { AuditService } from '../audit/audit.service';
import { AUDIT_OPERATION, AuditOperationOptions, auditEvent } from '../audit/audit-operation';
import { AuditActorType } from '../audit/audit.types';
import { AuthService } from './auth.service';
import { MVP_AI_ACCESS } from './mvp-ai-access';
export const SESSION_COOKIE = 'dva_session';
export const PublicAuth = () => SetMetadata('auth:public', true);
// Temporary, explicit opt-in for customer context/registration/detail/name updates (Jira 135).
// Do not apply this to administrator-only operations or to an entire controller.
export const MvpAiCustomerAccess = () => SetMetadata('auth:mvp-ai-customer', true);
export const Roles = (...roles: AdminRole[]) => SetMetadata('auth:roles', roles);
export type AuthRequest = Request & {
  requestId: string;
  admin: AdminPublic;
  sessionToken: string;
  auditActorType?: AuditActorType;
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
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await this.checkAccess(context);
    } catch (error) {
      const operation = this.reflector.get<AuditOperationOptions>(
        AUDIT_OPERATION,
        context.getHandler(),
      );
      if (operation)
        await this.audit.recordFailure(
          auditEvent(operation, context.switchToHttp().getRequest<AuthRequest>()),
          error,
        );
      throw error;
    }
  }
  private async checkAccess(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    // Existing health and PBX retain their dedicated authentication contracts.
    if (
      ['/health', '/health/ready', '/webhooks/pbx/call-ended'].includes(
        request.path.replace(/\/$/, ''),
      )
    )
      return true;
    if (
      this.reflector.get<boolean>(MVP_AI_ACCESS, context.getHandler()) &&
      !(request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
    ) {
      request.auditActorType = 'AI';
      return true;
    }
    request.sessionToken = readSessionToken(request) ?? '';
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('auth:mvp-ai-customer', targets)) {
      const hasSessionCookie = (request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
      const body: unknown = request.body;
      const changesStatus =
        request.method === 'PATCH' &&
        body !== null &&
        typeof body === 'object' &&
        Object.hasOwn(body, 'status');
      // A missing/stale administrator session must never turn a status change into an AI write.
      if (!hasSessionCookie && !changesStatus) {
        request.auditActorType = 'AI';
        return true;
      }
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.get('Origin');
      if (!origin || !this.config.get('CORS_ORIGINS', { infer: true }).includes(origin))
        throw new ApiException(403, 'FORBIDDEN', '허용된 Origin이 필요합니다.');
    }
    if (this.reflector.getAllAndOverride<boolean>('auth:public', targets)) return true;
    request.admin = await this.auth.authenticate(request.sessionToken);
    const roles = this.reflector.getAllAndOverride<AdminRole[]>('auth:roles', targets);
    if (roles && !roles.includes(request.admin.role))
      throw new ApiException(403, 'FORBIDDEN', '접근 권한이 없습니다.');
    return true;
  }
}
