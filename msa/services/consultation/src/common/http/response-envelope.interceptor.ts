import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { map } from 'rxjs';
import { ListResponse } from '../pagination';
import { type ContextRequest, isApiRequest } from './request-context';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  private readonly reflector = new Reflector();

  intercept(context: ExecutionContext, next: CallHandler) {
    if (this.reflector.get<boolean>(SSE_METADATA, context.getHandler()))
      return next.handle();
    const request = context.switchToHttp().getRequest<ContextRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value: unknown) => {
        if (!isApiRequest(request)) return value;
        if (response.statusCode === 204) return undefined;
        if (value instanceof ListResponse)
          return {
            data: value.data,
            hasNext: value.hasNext,
            total_count: value.total_count,
          };
        return { data: value ?? null, meta: { requestId: request.requestId } };
      }),
    );
  }
}
