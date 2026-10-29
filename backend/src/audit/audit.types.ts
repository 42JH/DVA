export const AUDIT_ACTOR_TYPES = ['ADMIN', 'AI', 'SYSTEM'] as const;
export const AUDIT_RESULTS = ['SUCCESS', 'DENIED', 'FAILED'] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface AuditEvent {
  actorId: number | null;
  actorType?: AuditActorType;
  actorName?: string;
  targetId: number | null;
  action: string;
  targetType: string;
  requestId: string;
}

export interface AuditLog {
  auditLogSeq: number;
  actorType: AuditActorType;
  actorSeq: number | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetSeq: number | null;
  targetAdminName: string | null;
  requestId: string;
  result: AuditResult;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}
