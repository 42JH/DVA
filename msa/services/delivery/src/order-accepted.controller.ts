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
import { validatePurgedParcelsEvent } from '@dva/events/call-read-references.cjs';
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
        'order:OrderParcelsPurged': async (client, event) => {
          try {
            validatePurgedParcelsEvent(event);
          } catch {
            throw new HttpException(
              { error: 'INVALID_ORDER_RETENTION_REQUEST' },
              422,
            );
          }
          const ids = event.payload.orderParcelSeqs;
          await this.lockParcels(client, ids);
          // Keep only parcel identities so delayed creation cannot restore expired data.
          await client.query(
            `INSERT INTO inbox_events(event_id,source,event_type,payload)
             SELECT md5('retired-order-parcel:'||id::text)::uuid,'order','OrderParcelRetired',
                    jsonb_build_object('orderParcelSeq',id) FROM unnest($1::int[]) AS id
             ON CONFLICT(event_id) DO NOTHING`,
            [ids],
          );
          await client.query(
            `DELETE FROM shipment_status_history WHERE shipment_seq IN (
               SELECT shipment_seq FROM shipments WHERE order_parcel_seq=ANY($1::int[]))`,
            [ids],
          );
          await client.query(
            'DELETE FROM shipments WHERE order_parcel_seq=ANY($1::int[])',
            [ids],
          );
        },
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

          await this.lockParcels(client, ids as number[]);
          const retired = await client.query(
            `SELECT 1 FROM inbox_events WHERE event_id IN (
               SELECT md5('retired-order-parcel:'||id::text)::uuid FROM unnest($1::int[]) AS id)
             AND source='order' AND event_type='OrderParcelRetired' LIMIT 1`,
            [ids],
          );
          if (retired.rowCount) return;
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

  private async lockParcels(client: PoolClient, ids: number[]) {
    await client.query(
      'SELECT pg_advisory_xact_lock(20261112,id) FROM unnest($1::int[]) AS id',
      [[...ids].sort((left, right) => left - right)],
    );
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
