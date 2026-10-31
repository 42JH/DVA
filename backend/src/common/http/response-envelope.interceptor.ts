import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { map } from 'rxjs';
import { ContextRequest, isApiRequest } from './request-context';
import { ListResponse } from '../pagination';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<ContextRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value: unknown) => {
        if (!isApiRequest(request)) return value;
        if (response.statusCode === 204) return undefined;
        if (value instanceof ListResponse)
          return { data: value.data, hasNext: value.hasNext, total_count: value.total_count };
        return { data: value ?? null, meta: { requestId: request.requestId } };
      }),
    );
  }
}
