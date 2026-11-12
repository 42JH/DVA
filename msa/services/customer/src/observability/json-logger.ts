import { LoggerService } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isUUID } from 'class-validator';
import { authenticationReasons, authenticationTypes } from './security-events';

export const logContext = new AsyncLocalStorage<{ requestId: string }>();
const events = new Set([
  'http_request',
  'authentication_success',
  'authentication_failure',
  'request_failed',
  'audit_write_failed',
  'recording_processing_failed',
  'recording_storage_unconfigured',
  'recording_worker_unavailable',
  'persona_notification_failed',
  'faq_notification_deferred',
  'faq_notification_retry',
  'database_connection_unavailable',
  'backend_started',
  'backend_startup_failed',
  'order_submission_result',
  'order_submission_result_save_failed',
  'dver_submission',
  'order_maintenance_failed',
  'paid_order_submission_deferred',
  'payment_worker_failed',
  'payment_reconcile_deferred',
  'retention_cleanup_failed',
  'retention_recording_deferred',
  'call_complaint_claim_deferred',
  'call_complaint_failed',
  'call_complaint_recording_unavailable',
  'call_complaint_input_too_long',
  'call_complaint_model_unavailable',
  'call_complaint_judged',
  'active_call_count_unavailable',
  'card_payment_deferred',
  'order_intake_finalization_deferred',
  'order_intake_submission_deferred',
  'order_intake_recovery_failed',
  'card_revocation_deferred',
  'call_end_matching_deferred',
]);
const outcomes = new Set(['ACCEPTED', 'SUBMISSION_FAILED', 'SUBMITTING_FAILED', 'SUBMITTING']);
const reasons = new Set([
  'authentication_rejected',
  'http_error',
  'response_too_large',
  'invalid_response',
  'timeout',
  'transport_error',
]);

// 원문을 재귀적으로 지우는 대신, 허용한 필드와 값만 새 객체에 복사한다.
// Error.message/stack, 본문, 헤더, URL, 전화번호, 주소는 입력 객체에 있어도 출력하지 않는다.
export function logRecord(level: string, input: unknown): Record<string, unknown> {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    service: 'customer',
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    level,
    event:
      typeof value.event === 'string' && events.has(value.event)
        ? value.event
        : 'application_message',
  };
  const requestId = value.requestId ?? logContext.getStore()?.requestId;
  if (record.event === 'call_complaint_judged') {
    if (typeof value.hasComplaint === 'boolean') record.hasComplaint = value.hasComplaint;
    if (
      Number.isInteger(value.complaintCount) &&
      Number(value.complaintCount) >= 0 &&
      Number(value.complaintCount) <= 2147483647
    )
      record.complaintCount = value.complaintCount;
  }
  if (Array.isArray(value.invalidFields))
    record.invalidFields = value.invalidFields
      .filter((field: unknown) => typeof field === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(field))
      .slice(0, 40);
  if (typeof requestId === 'string' && isUUID(requestId)) record.requestId = requestId;
  if (typeof value.eventId === 'string' && isUUID(value.eventId)) record.eventId = value.eventId;
  for (const key of ['orderSeq', 'callSessionSeq']) {
    const number = value[key];
    if (
      typeof number === 'number' &&
      Number.isInteger(number) &&
      number > 0 &&
      number <= 2147483647
    )
      record[key] = number;
  }
  if (
    typeof value.statusCode === 'number' &&
    Number.isInteger(value.statusCode) &&
    value.statusCode >= 100 &&
    value.statusCode <= 599
  )
    record.statusCode = value.statusCode;
  if (
    typeof value.durationMs === 'number' &&
    Number.isFinite(value.durationMs) &&
    value.durationMs >= 0
  )
    record.durationMs = Math.round(value.durationMs);
  if (
    typeof value.method === 'string' &&
    /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|OTHER)$/.test(value.method)
  )
    record.method = value.method;
  if (
    typeof value.route === 'string' &&
    (value.route === 'unmatched' || /^\/[a-zA-Z/:_-]{0,160}$/.test(value.route))
  )
    record.route = value.route;
  if (typeof value.outcome === 'string' && outcomes.has(value.outcome))
    record.outcome = value.outcome;
  const authentication = ['authentication_success', 'authentication_failure'].includes(
    String(record.event),
  );
  if (
    typeof value.reason === 'string' &&
    (reasons.has(value.reason) || (authentication && authenticationReasons.has(value.reason)))
  )
    record.reason = value.reason;
  if (authentication) {
    if (typeof value.authType === 'string' && authenticationTypes.has(value.authType))
      record.authType = value.authType;
    for (const key of ['accountKey', 'sourceKey'])
      if (typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
        record[key] = value[key];
  }
  if (typeof value.receipt === 'string' && /^[a-f0-9]{64}$/.test(value.receipt))
    record.receipt = value.receipt;
  return record;
}

export class JsonLogger implements LoggerService {
  constructor(
    private readonly output: (line: string) => void = (line) => {
      // 출력 지연 중에는 메모리에 로그를 계속 쌓지 않는다. 관측용 로그 일부 유실을 허용한다.
      if (process.stdout.writableLength < 1_048_576) process.stdout.write(line);
    },
  ) {}
  private write(level: string, message: unknown): void {
    try {
      this.output(JSON.stringify(logRecord(level, message)) + '\n');
    } catch {
      /* 로그 장애는 업무 응답을 바꾸지 않는다. */
    }
  }
  log(message: unknown): void {
    this.write('info', message);
  }
  error(message: unknown): void {
    this.write('error', message);
  }
  warn(message: unknown): void {
    this.write('warn', message);
  }
  debug(message: unknown): void {
    this.write('debug', message);
  }
  verbose(message: unknown): void {
    this.write('debug', message);
  }
  fatal(message: unknown): void {
    this.write('error', message);
  }
}
