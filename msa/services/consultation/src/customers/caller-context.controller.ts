import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateEvent } from '@dva/events';
import { isUUID } from 'class-validator';
import { createValidationPipe } from '../common/http/validation.pipe';
import { CallerContextRequestDto } from './dto/caller-context.dto';
import { CustomersService } from './customers.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/caller-context')
export class CallerContextCommandController {
  constructor(private readonly customers: CustomersService) {}
  @Post()
  @HttpCode(200)
  async register(@Body() input: unknown) {
    try {
      validateEvent(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CONTEXT_EVENT' }, 400);
    }
    const p = input.payload;
    if (
      input.source !== 'customer' ||
      input.eventType !== 'CallerContextRequested' ||
      Object.keys(p).sort().join(',') !== 'actorId,input,requestId' ||
      !(
        p.actorId === null ||
        (Number.isInteger(p.actorId) &&
          Number(p.actorId) > 0 &&
          Number(p.actorId) <= 2147483647)
      ) ||
      typeof p.requestId !== 'string' ||
      !isUUID(p.requestId)
    )
      throw new HttpException({ error: 'INVALID_CONTEXT_EVENT' }, 422);
    const request = (await createValidationPipe().transform(p.input, {
      metatype: CallerContextRequestDto,
      type: 'body',
    })) as CallerContextRequestDto;
    if (!request.call)
      throw new HttpException({ error: 'CALL_IDENTITY_REQUIRED' }, 422);
    const payload = await this.customers.context(
      request,
      p.actorId as number | null,
      p.requestId,
      input,
    );
    return { eventId: input.eventId, status: 'processed', payload };
  }
}
