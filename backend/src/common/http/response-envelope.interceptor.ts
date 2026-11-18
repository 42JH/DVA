import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Response } from 'express';
import { SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { map } from 'rxjs';
import { ContextRequest, isApiRequest } from './request-context';
import { ListResponse } from '../pagination';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  private readonly reflector = new Reflector();

  intercept(context: ExecutionContext, next: CallHandler) {
    if (this.reflector.get<boolean>(SSE_METADATA, context.getHandler())) return next.handle();
    const request = context.switchToHttp().getRequest<ContextRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((value: unknown) => {
        if (!isApiRequest(request)) return value;
        if (response.statusCode === 204) return undefined;
        if (value instanceof ListResponse) return { ...value };
        return { data: value ?? null, meta: { requestId: request.requestId } };
      }),
    );
  }
}
