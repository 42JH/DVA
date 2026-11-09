import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export const OrderRequestKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Request>().get('Idempotency-Key'),
);
