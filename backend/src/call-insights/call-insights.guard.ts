import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthRequest } from '../auth/auth.guard';
import { AUDIT_OPERATION, AuditOperationOptions, auditEvent } from '../audit/audit-operation';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { Environment } from '../config/environment';

@Injectable()
export class CallInsightsGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.auditActorType = undefined;
    try {
      const expected = this.config.get('AI_INSIGHTS_TOKEN', { infer: true });
      if (!expected)
        throw new ApiException(
          503,
          'DEPENDENCY_UNAVAILABLE',
          'AI 통화 분석 인증이 설정되지 않았습니다.',
        );
      const authorization = request.get('Authorization') ?? '';
      const count = request.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization',
      ).length;
      if (
        count !== 1 ||
        !authorization.startsWith('Bearer ') ||
        !timingSafeEqual(
          createHash('sha256').update(authorization.slice(7)).digest(),
          createHash('sha256').update(expected).digest(),
        )
      )
        throw new ApiException(401, 'UNAUTHORIZED', '유효한 AI 통화 분석 인증이 필요합니다.');
      request.auditActorType = 'AI';
      return true;
    } catch (error) {
      const operation = this.reflector.get<AuditOperationOptions>(
        AUDIT_OPERATION,
        context.getHandler(),
      );
      if (operation) await this.audit.recordFailure(auditEvent(operation, request), error);
      throw error;
    }
  }
}
