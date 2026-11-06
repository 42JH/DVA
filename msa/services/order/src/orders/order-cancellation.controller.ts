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
import { validateOrderCancellation } from '@dva/events/order-cancellation.cjs';
import { OrdersService } from './orders.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/order-cancellation')
export class OrderCancellationController {
  constructor(private readonly orders: OrdersService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async cancel(@Body() event: unknown) {
    try {
      validateOrderCancellation(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_CANCELLATION' }, 422);
    }
    const command = event.payload.command;
    await this.orders.cancelScoped(
      null,
      command.id,
      command.requestId,
      command.orderParcelSeqs ?? undefined,
      event.payload.customerSeq!,
    );
    return { eventId: event.eventId, status: 'processed', payload: null };
  }
}
