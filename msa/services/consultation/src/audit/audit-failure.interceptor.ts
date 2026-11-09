import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError } from 'rxjs';
import {
  AUDIT_OPERATION,
  AuditOperationOptions,
  auditEvent,
} from './audit-operation';
import { AuditService } from './audit.service';

@Injectable()
export class AuditFailureInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const operation = this.reflector.get<AuditOperationOptions>(
      AUDIT_OPERATION,
      context.getHandler(),
    );
    if (!operation) return next.handle();
    return next.handle().pipe(
      catchError(async (error: unknown) => {
        // Service transaction promises reject only after rollback has finished.
        await this.audit.recordFailure(
          auditEvent(operation, context.switchToHttp().getRequest()),
          error,
        );
        throw error;
      }),
    );
  }
}
