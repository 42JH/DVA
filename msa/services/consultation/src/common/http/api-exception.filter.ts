import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiException, type ErrorCode } from '../errors/api.exception';
import { type ContextRequest, isApiRequest } from './request-context';

const statusCodes: Record<number, ErrorCode> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'INVALID_STATE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'EXTERNAL_API_ERROR',
  503: 'DEPENDENCY_UNAVAILABLE',
  504: 'DEPENDENCY_UNAVAILABLE',
};
const messages: Record<number, string> = {
  400: '요청 형식을 확인해 주세요.',
  401: '인증이 필요합니다.',
  403: '접근 권한이 없습니다.',
  404: '대상을 찾을 수 없습니다.',
  409: '현재 상태에서는 처리할 수 없습니다.',
  413: '요청 크기가 제한을 초과했습니다.',
  415: '지원하지 않는 요청 형식입니다.',
  422: '입력값을 확인해 주세요.',
  429: '요청이 너무 많습니다.',
  500: '서버 오류가 발생했습니다.',
  502: '외부 서비스 요청에 실패했습니다.',
  503: '서비스를 일시적으로 사용할 수 없습니다.',
  504: '외부 서비스 응답을 확인할 수 없습니다.',
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<ContextRequest>();
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) return;
    const requestId = request.requestId ?? randomUUID();
    response.setHeader('X-Request-Id', requestId);
    let status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    // SQL errors are classified by SQLSTATE, never by raw messages or query parameters.
    const sqlState =
      exception && typeof exception === 'object' && 'code' in exception
        ? exception.code
        : undefined;
    if (!(exception instanceof HttpException)) {
      if (
        exception &&
        typeof exception === 'object' &&
        'type' in exception &&
        exception.type === 'entity.too.large'
      )
        status = 413;
      if (sqlState === '23505') status = 409;
      if (sqlState === '23503') status = 409;
      if (sqlState === '23514') status = 422;
    }
    if (status >= 500)
      this.logger.error({
        event: 'request_failed',
        requestId,
        statusCode: status,
      });
    if (!isApiRequest(request)) {
      // Keep the established health/PBX response contract while redacting unknown failures.
      const body =
        exception instanceof HttpException
          ? exception.getResponse()
          : undefined;
      response.status(status).json(
        typeof body === 'object'
          ? body
          : {
              statusCode: status,
              message:
                typeof body === 'string' ? body : 'Internal server error',
            },
      );
      return;
    }
    const custom =
      exception instanceof ApiException ? exception.getResponse() : undefined;
    const code =
      sqlState === '23505'
        ? 'DUPLICATE_RESOURCE'
        : sqlState === '23514'
          ? 'BUSINESS_RULE_VIOLATION'
          : (statusCodes[status] ?? 'INTERNAL_ERROR');
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({
      error: custom ?? {
        code,
        message: messages[status] ?? messages[500],
        details: [],
      },
      meta: { requestId },
    });
  }
}
