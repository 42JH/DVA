import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Environment } from '../config/environment';
import { AuthRequest } from '../auth/auth.guard';
import { MVP_AI_ACCESS } from '../auth/mvp-ai-access';
import { ApiException } from '../common/errors/api.exception';
import { AUDIT_OPERATION, AuditOperationOptions, auditEvent } from '../audit/audit-operation';
import { AuditService } from '../audit/audit.service';

const ADMIN_READ = 'ai-settings:admin-read';
// 기존 AI 진입 표시를 재사용하되 이 가드를 항상 함께 붙여 서비스 토큰을 검증한다.
export const AiSettingsAccess = (allowAdminRead = false) =>
  applyDecorators(
    SetMetadata(MVP_AI_ACCESS, true),
    SetMetadata(ADMIN_READ, allowAdminRead),
    UseGuards(AiSettingsGuard),
  );

@Injectable()
export class AiSettingsGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    // 공통 MVP 진입과 달리 이 경로는 서비스 토큰 검증 후에만 AI로 식별한다.
    request.auditActorType = undefined;
    try {
      return this.checkAccess(context);
    } catch (error) {
      const operation = this.reflector.get<AuditOperationOptions>(
        AUDIT_OPERATION,
        context.getHandler(),
      );
      if (operation) await this.audit.recordFailure(auditEvent(operation, request), error);
      throw error;
    }
  }

  private checkAccess(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (this.reflector.get<boolean>(ADMIN_READ, context.getHandler()) && request.admin) return true;
    request.securityAuthType = 'ai_persona';
    const expected = this.config.get('AI_PERSONA_TOKEN', { infer: true });
    if (!expected)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'AI 페르소나 연동이 설정되지 않았습니다.',
      );
    const authorization = request.get('Authorization') ?? '';
    const count = request.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length;
    const valid =
      count === 1 &&
      authorization.startsWith('Bearer ') &&
      timingSafeEqual(
        createHash('sha256').update(authorization.slice(7)).digest(),
        createHash('sha256').update(expected).digest(),
      );
    if (!valid) throw new ApiException(401, 'UNAUTHORIZED', '유효한 AI 서비스 인증이 필요합니다.');
    delete request.securityAuthType;
    request.auditActorType = 'AI';
    return true;
  }
}
