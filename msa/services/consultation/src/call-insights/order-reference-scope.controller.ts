import {
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OrderReferenceScopeService } from './order-reference-scope.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/call-event-order-scope')
export class OrderReferenceScopeController {
  constructor(private readonly scopes: OrderReferenceScopeService) {}
  @Post('continue')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async continue(@Body() event: unknown) {
    const payload = await this.scopes.continue(event);
    return {
      eventId: (event as { eventId: string }).eventId,
      status: 'processed',
      payload,
    };
  }
}
