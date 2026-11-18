import { HttpException } from '@nestjs/common';

export interface ErrorDetail {
  field: string;
  reason: string;
}

export type ErrorCode =
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_PENDING'
  | 'SIGNUP_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE_RESOURCE'
  | 'INVALID_STATE'
  | 'VERSION_CONFLICT'
  | 'VALIDATION_FAILED'
  | 'BUSINESS_RULE_VIOLATION'
  | 'INTERNAL_ERROR'
  | 'EXTERNAL_API_ERROR'
  | 'PAYMENT_RESULT_UNKNOWN'
  | 'PAYMENT_FAILED'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'REQUEST_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'EVENT_PAYLOAD_CONFLICT';

export class ApiException extends HttpException {
  constructor(status: number, code: ErrorCode, message: string, details: ErrorDetail[] = []) {
    super({ code, message, details }, status);
  }
}

export class RateLimitException extends ApiException {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
}
