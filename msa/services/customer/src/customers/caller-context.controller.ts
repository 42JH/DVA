import { Body, Controller, HttpCode, HttpException, Post, SetMetadata } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateEvent } from '@dva/events';
import { CustomersRepository } from './customers.repository';

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/caller-context')
export class CallerContextQueryController {
  constructor(private readonly customers: CustomersRepository) {}

  @Post()
  @HttpCode(200)
  async query(@Body() input: unknown) {
    try {
      validateEvent(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CONTEXT_EVENT' }, 400);
    }
    if (
      input.source !== 'consultation' ||
      !['CallerContextRequested', 'CallCustomerRequested'].includes(input.eventType) ||
      Object.keys(input.payload).join(',') !== 'phoneNumber' ||
      typeof input.payload.phoneNumber !== 'string' ||
      !/^[0-9]+(?![\s\S])/.test(input.payload.phoneNumber)
    )
      throw new HttpException({ error: 'INVALID_CONTEXT_EVENT' }, 422);
    // Queries read current state on every retry and do not persist private response snapshots.
    const payload =
      input.eventType === 'CallerContextRequested'
        ? await this.customers.context(input.payload.phoneNumber)
        : { customerSeq: await this.customers.callCustomer(input.payload.phoneNumber) };
    return { eventId: input.eventId, status: 'processed', payload };
  }
}
