import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditEvent } from './audit.types';

export const AUDIT_OPERATION = 'audit:operation';
export interface AuditOperationOptions {
  action: string;
  targetType: string;
  target: 'actor' | 'id' | 'none';
}

export const AuditOperation = (options: AuditOperationOptions) =>
  SetMetadata(AUDIT_OPERATION, options);

export function auditEvent(
  options: AuditOperationOptions,
  request: Request & { requestId: string; admin?: { adminUserSeq: number } },
): AuditEvent {
  const rawId = request.params.id;
  const id = typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : NaN;
  const actorId = request.admin?.adminUserSeq ?? null;
  return {
    action: options.action,
    targetType: options.targetType,
    actorId,
    targetId:
      options.target === 'actor'
        ? actorId
        : options.target === 'id' && Number.isInteger(id) && id > 0 && id <= 2147483647
          ? id
          : null,
    requestId: request.requestId,
  };
}
