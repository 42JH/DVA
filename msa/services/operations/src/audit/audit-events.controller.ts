import { Body, Controller, HttpException, Post, Headers, HttpCode } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Event } from '@dva/events';
import { InternalCustomerAuth } from '../auth/auth.guard';
import { CustomerAuditReceiver } from './customer-audit.receiver';

@ApiExcludeController()
@InternalCustomerAuth()
@Controller('internal')
export class AuditEventsController {
  constructor(private readonly events: CustomerAuditReceiver) {}
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
