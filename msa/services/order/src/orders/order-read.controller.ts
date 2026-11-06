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
import { validateOrderRead } from '@dva/events/order-read.cjs';
import { OrdersService } from './orders.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/order-read')
export class OrderReadController {
  constructor(private readonly orders: OrdersService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() event: unknown) {
    try {
      validateOrderRead(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_READ' }, 422);
    }
    const payload = await this.orders.execute(event.payload.command, event.payload.customerSeq!);
    return { eventId: event.eventId, status: 'processed', payload };
  }
}
