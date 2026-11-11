import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { createReceiver, type Event } from '@dva/events';
import type { PoolClient } from 'pg';
import { DatabaseService } from './database.service';
import type { Environment } from './environment';

@ApiExcludeController()
@Controller('internal/order-accepted')
export class OrderAcceptedController {
  private readonly receiveEvent: ReturnType<typeof createReceiver>;

  constructor(
    database: DatabaseService,
    config: ConfigService<Environment, true>,
  ) {
    this.receiveEvent = createReceiver<PoolClient>({
      pool: database.pool,
      sources: { order: config.get('CUSTOMER_AUTH_TOKEN', { infer: true }) },
      handlers: {
        'order:OrderSubmissionDeliveryRequested': async (client, event) => {
          const ids = event.payload.orderParcelSeqs;
          if (
            Object.keys(event.payload).join(',') !== 'orderParcelSeqs' ||
            !Array.isArray(ids) ||
            ids.length < 1 ||
            !ids.every(
              (id: unknown) =>
                typeof id === 'number' &&
                Number.isInteger(id) &&
                id >= 1 &&
                id <= 2147483647,
            ) ||
            new Set(ids).size !== ids.length
          )
            throw new HttpException(
              { error: 'INVALID_ORDER_DELIVERY_REQUEST' },
              422,
            );

          await client.query(
            `WITH created AS (
               INSERT INTO shipments(order_parcel_seq,tracking_number,status)
               SELECT id,'DVA-'||gen_random_uuid()::text,'paid' FROM unnest($1::int[]) AS id
               RETURNING shipment_seq
             ) INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type)
               SELECT shipment_seq,gen_random_uuid(),'paid','SYSTEM' FROM created`,
            [ids],
          );
        },
      },
    });
  }

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(
    @Body() event: Event,
    @Headers('authorization') authorization: string,
  ) {
    try {
      return await this.receiveEvent(event, authorization);
    } catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        'code' in error &&
        typeof error.status === 'number' &&
        error.status >= 400 &&
        error.status < 500
      )
        throw new HttpException({ error: error.code }, error.status);
      throw new HttpException({ error: 'EVENT_PROCESSING_FAILED' }, 500);
    }
  }
}
