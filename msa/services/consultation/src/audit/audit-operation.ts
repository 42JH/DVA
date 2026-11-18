import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditActorType, AuditEvent } from './audit.types';

export const AUDIT_OPERATION = 'audit:operation';
export interface AuditOperationOptions {
  action: string;
  targetType: string;
  target: 'actor' | 'id' | 'ids' | 'none';
  idsField?: string;
}

export const AuditOperation = (options: AuditOperationOptions) =>
  SetMetadata(AUDIT_OPERATION, options);

export function auditEvent(
  options: AuditOperationOptions,
  request: Request & {
    requestId: string;
    admin?: { adminUserSeq: number; name?: string };
    auditActorType?: AuditActorType;
  },
): AuditEvent {
  const rawId = request.params.id;
  const id =
    typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : NaN;
  const body: unknown = request.body;
  const ids: unknown =
    options.idsField && body && typeof body === 'object'
      ? (body as Record<string, unknown>)[options.idsField]
      : undefined;
  const bodyId: unknown =
    Array.isArray(ids) && ids.length === 1 ? ids[0] : undefined;
  const actorId =
    request.auditActorType === 'AI'
      ? null
      : (request.admin?.adminUserSeq ?? null);
  return {
    action: options.action,
    targetType: options.targetType,
    actorId,
    actorType:
      actorId === null ? (request.auditActorType ?? 'SYSTEM') : 'ADMIN',
    actorName: actorId === null ? undefined : request.admin?.name,
    targetId:
      options.target === 'actor'
        ? actorId
        : options.target === 'ids' &&
            typeof bodyId === 'number' &&
            Number.isInteger(bodyId) &&
            bodyId > 0 &&
            bodyId <= 2147483647
          ? bodyId
          : options.target === 'id' &&
              Number.isInteger(id) &&
              id > 0 &&
              id <= 2147483647
            ? id
            : null,
    requestId: request.requestId,
  };
}
