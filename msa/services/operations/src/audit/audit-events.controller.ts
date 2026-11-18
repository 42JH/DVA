import {
  Body,
  Controller,
  HttpException,
  Post,
  Headers,
  HttpCode,
  SetMetadata,
  Header,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Event } from '@dva/events';
import { InternalServiceAuth } from '../auth/auth.guard';
import { ServiceAuditReceiver } from './service-audit.receiver';
import { FaqWritePending } from '@dva/events/faq-conversion.cjs';

@ApiExcludeController()
@InternalServiceAuth()
@Controller('internal')
export class AuditEventsController {
  constructor(private readonly events: ServiceAuditReceiver) {}
  @Post('events/faq-conversion')
  @SetMetadata('auth:internal-consultation', true)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async conversion(@Body() event: unknown, @Headers('authorization') authorization: string) {
    try {
      return await this.events.prepareConversion(event, authorization);
    } catch (error: unknown) {
      if (error instanceof FaqWritePending)
        throw new HttpException({ error: 'FAQ_WRITE_PENDING' }, 409);
      if (error instanceof HttpException) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        throw new HttpException(
          {
            error: {
              code: 'DUPLICATE_RESOURCE',
              message: '현재 상태에서는 처리할 수 없습니다.',
              details: [],
            },
          },
          409,
        );
      throw new HttpException({ error: 'EVENT_PROCESSING_FAILED' }, 500);
    }
  }
  @Post('events')
  @HttpCode(200)
  async receive(@Body() event: Event, @Headers('authorization') authorization: string) {
    try {
      return await this.events.receive(event, authorization);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        'code' in error &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500
      )
        throw new HttpException({ error: error.code }, error.status);
      throw new HttpException({ error: 'EVENT_PROCESSING_FAILED' }, 500);
    }
  }
}
