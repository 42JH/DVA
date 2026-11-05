import { Body, Controller, HttpCode, HttpException, Post, SetMetadata } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateScopeEvent } from '@dva/events/call-scope.cjs';
import { createValidationPipe } from '../common/http/validation.pipe';
import { CustomersService } from '../customers/customers.service';
import { UpdateCustomerDto } from '../customers/dto/customer-request.dto';
import { PinsService } from '../pins/pins.service';
import { CreatePinDto, ListPinsQueryDto, UpdatePinDto } from '../pins/dto/pin-request.dto';
import { CallScopeService } from './call-scope.service';

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/call-scope')
export class CallScopeExecutionController {
  constructor(
    private readonly scope: CallScopeService,
    private readonly customers: CustomersService,
    private readonly pins: PinsService,
  ) {}
  @Post()
  @HttpCode(200)
  async execute(@Body() event: unknown) {
    try {
      validateScopeEvent(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_SCOPE_EVENT' }, 422);
    }
    const command = event.payload.command;
    const type = {
      CustomerUpdated: UpdateCustomerDto,
      PersonalPinsListed: ListPinsQueryDto,
      PersonalPinCreated: CreatePinDto,
      PersonalPinUpdated: UpdatePinDto,
    }[command.operation];
    const input: unknown = await createValidationPipe().transform(command.input, {
      metatype: type,
      type: command.operation === 'PersonalPinsListed' ? 'query' : 'body',
    });
    const header = String(command.callSessionSeq);
    const payload = await this.scope.run(event, async () => {
      switch (command.operation) {
        case 'CustomerUpdated':
          await this.customers.update(
            command.id,
            input as UpdateCustomerDto,
            null,
            command.requestId,
            header,
          );
          return null;
        case 'PersonalPinsListed':
          return this.pins.listPersonal(command.id, input as ListPinsQueryDto, null, header);
        case 'PersonalPinCreated':
          return this.pins.createPersonal(
            command.id,
            input as CreatePinDto,
            null,
            command.requestId,
            header,
          );
        case 'PersonalPinUpdated':
          return this.pins.updatePersonal(
            command.id,
            input as UpdatePinDto,
            null,
            command.requestId,
            header,
          );
      }
    });
    return { eventId: event.eventId, status: 'processed', payload };
  }
}
