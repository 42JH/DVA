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
import { OrganizationBillingService } from './organization-billing.service';

@ApiExcludeController()
@SetMetadata('auth:internal-operations', true)
@Controller('internal/billing')
export class BillingScopeController {
  constructor(private readonly billing: OrganizationBillingService) {}
  @Post('companies')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async companies(@Body() event: unknown) {
    try {
      validateBilling(event, 'BillingOrganizationsReadRequested', 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_BILLING_COMMAND' }, 422);
    }
    return { eventId: event.eventId, status: 'processed', payload: await this.billing.companies() };
  }
  @Post('rollover')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async rollover(@Body() event: unknown) {
    try {
      validateBilling(event, 'BillingRolloverRequested', 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_BILLING_COMMAND' }, 422);
    }
    return {
      eventId: event.eventId,
      status: 'processed',
      payload: await this.billing.rollover(event),
    };
  }
}
