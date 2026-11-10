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
import { validateOrderRead, validateAdminOrderRead } from '@dva/events/order-read.cjs';
import { OrdersService } from './orders.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal')
export class OrderReadController {
  constructor(private readonly orders: OrdersService) {}
  @Post('admin-order-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async admin(@Body() event: unknown) {
    try {
      validateAdminOrderRead(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_ADMIN_ORDER_READ' }, 422);
    }
    const payload = await this.orders.executeAdmin(event);
    return { eventId: event.eventId, status: 'processed', payload };
  }
  @Post('order-read')
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
