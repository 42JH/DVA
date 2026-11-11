import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateBilling } from '@dva/events/billing.cjs';
import { BillingService } from './billing.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Post('customer')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async customer(@Body() event: unknown) {
    try {
      validateBilling(event, 'CustomerBillingReadRequested', 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_BILLING_COMMAND' }, 422);
    }
    return {
      eventId: event.eventId,
      status: 'processed',
      payload: await this.billing.readCustomer(event.payload.id, event.payload.month),
    };
  }

  @Post('read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async read(@Body() event: unknown) {
    try {
      validateBilling(event, 'BillingReadRequested', 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_BILLING_COMMAND' }, 422);
    }
    const p = event.payload;
    return {
      eventId: event.eventId,
      status: 'processed',
      payload: await this.billing.read(p.id, p.month, p.organizationName),
    };
  }
  @Post('initialize')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async initialize(@Body() event: unknown) {
    try {
      validateBilling(event, 'BillingRolloverRequested', 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_BILLING_COMMAND' }, 422);
    }
    return {
      eventId: event.eventId,
      status: 'processed',
      payload: await this.billing.initialize(event),
    };
  }
}
