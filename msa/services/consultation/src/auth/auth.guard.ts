import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Environment } from '../config/environment';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AdminPublic, AdminRole } from '../admins/admins.types';
import { ApiException } from '../common/errors/api.exception';
import { AuthService } from './auth.service';
import { MVP_AI_ACCESS } from './mvp-ai-access';
import {
  AUDIT_OPERATION,
  type AuditOperationOptions,
  auditEvent,
} from '../audit/audit-operation';
import type { AuditActorType } from '../audit/audit.types';
import { AuditService } from '../audit/audit.service';
import type { AuthenticationType } from '../observability/security-events';
export const SESSION_COOKIE = 'dva_session';
export const AiBusinessAccess = () => SetMetadata('auth:ai-business', true);
export const PublicAuth = () => SetMetadata('auth:public', true);
export const MvpAiCustomerAccess = () =>
  SetMetadata('auth:mvp-ai-customer', true);
export const Roles = (...roles: AdminRole[]) =>
  SetMetadata('auth:roles', roles);
export type AuthRequest = Request & {
  requestId: string;
  admin: AdminPublic;
  sessionToken: string;
  auditActorType?: AuditActorType;
  securityAuthType?: AuthenticationType;
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
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
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
          auditEvent(
            operation,
            context.switchToHttp().getRequest<AuthRequest>(),
          ),
          error,
        );
      throw error;
    }
  }
  private async checkAccess(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>('auth:ai-business', targets)
    ) {
      this.authenticateAi(request);
      return true;
    }
    const fromCustomer = this.reflector.getAllAndOverride<boolean>(
      'auth:internal-customer',
      targets,
    );
    if (
      fromCustomer ||
      this.reflector.getAllAndOverride<boolean>(
        'auth:internal-operations',
        targets,
      )
    ) {
      const expected = Buffer.from(
        'Bearer ' +
          this.config.get(
            fromCustomer ? 'CUSTOMER_AUTH_TOKEN' : 'CONSULTATION_AUTH_TOKEN',
            { infer: true },
          ),
      );
      const actual = Buffer.from(request.get('Authorization') ?? '');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new ApiException(403, 'FORBIDDEN', '서비스 인증이 필요합니다.');
      return true;
    }
    if (request.path.replace(/\/$/, '') === '/webhooks/pbx/call-ended')
      return true;
    if (this.reflector.getAllAndOverride<boolean>('auth:public', targets))
      return true;
    if (this.reflector.get<boolean>(MVP_AI_ACCESS, context.getHandler())) {
      const hasCookie = (request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
      if (!hasCookie) {
        request.auditActorType = 'AI';
        return true;
      }
    }
    request.sessionToken = readSessionToken(request) ?? '';
    if (
      this.reflector.getAllAndOverride<boolean>(
        'auth:mvp-ai-customer',
        targets,
      ) &&
      !(request.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`))
    ) {
      this.authenticateAi(request);
      return true;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.get('Origin');
      if (
        !origin ||
        !this.config.get('CORS_ORIGINS', { infer: true }).includes(origin)
      )
        throw new ApiException(403, 'FORBIDDEN', '허용된 Origin이 필요합니다.');
    }
    request.securityAuthType = 'admin_session';
    request.admin = await this.auth.authenticate(request.sessionToken);
    delete request.securityAuthType;
    const roles = this.reflector.getAllAndOverride<AdminRole[]>(
      'auth:roles',
      targets,
    );
    if (roles && !roles.includes(request.admin.role))
      throw new ApiException(403, 'FORBIDDEN', '접근 권한이 없습니다.');
    return true;
  }

  private authenticateAi(request: AuthRequest): void {
    request.securityAuthType = 'ai_business';
    const expected = this.config.get('AI_BUSINESS_TOKEN', { infer: true });
    if (!expected)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'AI 업무 인증이 설정되지 않았습니다.',
      );
    const authorization = request.get('Authorization') ?? '';
    const count = request.rawHeaders.filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length;
    if (
      count !== 1 ||
      !authorization.startsWith('Bearer ') ||
      !timingSafeEqual(
        createHash('sha256').update(authorization.slice(7)).digest(),
        createHash('sha256').update(expected).digest(),
      )
    )
      throw new ApiException(
        401,
        'UNAUTHORIZED',
        '유효한 AI 업무 인증이 필요합니다.',
      );
    delete request.securityAuthType;
    request.auditActorType = 'AI';
  }
}
