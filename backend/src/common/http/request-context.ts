import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { NextFunction, Request, Response } from 'express';

export const API_PREFIX = 'api';
export type ContextRequest = Request & { requestId?: string };

export function isApiRequest(request: Request): boolean {
  return request.path === `/${API_PREFIX}` || request.path.startsWith(`/${API_PREFIX}/`);
}

export function requestContext(logger: Pick<Logger, 'log'>) {
  return (request: ContextRequest, response: Response, next: NextFunction): void => {
    const incoming = request.get('X-Request-Id');
    request.requestId = incoming && isUUID(incoming) ? incoming : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    if (isApiRequest(request)) response.setHeader('Cache-Control', 'no-store');
    const start = performance.now();
    response.once('finish', () => {
      // Route templates exclude query strings, resource IDs, headers and request bodies.
      const route: unknown = request.route;
      const template =
        route && typeof route === 'object' && 'path' in route ? route.path : undefined;
      logger.log({
        event: 'http_request',
        requestId: request.requestId,
        method: request.method,
        route: typeof template === 'string' ? template : 'unmatched',
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - start),
      });
    });
    next();
  };
}
