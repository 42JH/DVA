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
  metadata?: {
    organizationSeq?: number;
    organizationName?: string;
    departmentSeq?: number | null;
    departmentName?: string | null;
    customerSeq?: number;
    amountBefore?: number | null;
    amountAfter?: number | null;
    orderParcelSeqs?: number[];
    billingMonth?: string;
    paymentMethodType?: string;
    reason?:
      | 'PAYMENT_EXPIRED'
      | 'PAYMENT_DECLINED'
      | 'PAYMENT_RESULT_UNKNOWN'
      | 'PAYMENT_REQUEST_FAILED'
      | 'MODEL_UNAVAILABLE'
      | 'RECORDING_UNAVAILABLE'
      | 'INPUT_TOO_LONG';
    hasComplaint?: boolean;
    complaintCount?: number;
  };
}

export interface AuditLog {
  actorLabel: 'AI' | 'SYSTEM' | '운영자';
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
