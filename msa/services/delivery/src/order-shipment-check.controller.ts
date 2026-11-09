import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { validateEvent } from '@dva/events';
import type { Environment } from './environment';
import { DatabaseService } from './database.service';

@ApiExcludeController()
@Controller('internal/order-shipment-check')
export class OrderShipmentCheckController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(
    @Body() event: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    const expected = Buffer.from(
      'Bearer ' + this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
    );
    const actual = Buffer.from(authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new HttpException({ error: 'EVENT_UNAUTHORIZED' }, 403);
    try {
      validateEvent(event);
      const ids = event.payload.orderParcelSeqs;
      if (
        event.source !== 'order' ||
        event.eventType !== 'OrderShipmentCheckRequested' ||
        Object.keys(event.payload).join(',') !== 'orderParcelSeqs' ||
        !Array.isArray(ids) ||
        ids.some(
          (value) =>
            !Number.isInteger(value) || value < 1 || value > 2147483647,
        ) ||
        new Set(ids).size !== ids.length
      )
        throw new Error('Invalid shipment check');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_SHIPMENT_CHECK' }, 422);
    }
    try {
      const blocked = await this.database.transaction(async (client) => {
        const result = await client.query(
          `SELECT order_parcel_seq,status FROM shipments
           WHERE order_parcel_seq=ANY($1::int[]) ORDER BY shipment_seq FOR UPDATE`,
          [event.payload.orderParcelSeqs],
        );
        return result.rowCount !== 0;
      });
      return {
        eventId: event.eventId,
        status: 'processed',
        payload: { blocked },
      };
    } catch {
      throw new HttpException({ error: 'DEPENDENCY_UNAVAILABLE' }, 503);
    }
  }
}
