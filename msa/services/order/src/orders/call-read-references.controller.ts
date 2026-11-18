import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createReceiver } from '@dva/events';
import type { PoolClient } from 'pg';
import {
  validateReferenceQuery,
  validateRetainedCustomersQuery,
  validatePurgedCardsEvent,
  validatePurgedCallsEvent,
  type ReferenceRows,
} from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/call-read-references')
export class CallReadReferencesController {
  private readonly receiveEvent: ReturnType<typeof createReceiver>;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Environment, true>,
  ) {
    this.receiveEvent = createReceiver<PoolClient>({
      pool: database.pool,
      sources: {
        customer: config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        consultation: config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      },
      handlers: {
        'customer:CustomerPaymentCardsPurged': async (client, event) => {
          await client.query(
            'UPDATE order_payment_requests SET payment_card_seq=NULL WHERE payment_card_seq=ANY($1::int[])',
            [event.payload.ids],
          );
        },
        'consultation:ConsultationCallsPurged': async (client, event) => {
          await client.query(
            'DELETE FROM empty_ai_order_results WHERE call_session_seq=ANY($1::int[])',
            [event.payload.ids],
          );
        },
      },
    });
  }

  @Post('events')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(@Body() input: unknown, @Headers('authorization') authorization: string) {
    const calls =
      input !== null &&
      typeof input === 'object' &&
      'eventType' in input &&
      input.eventType === 'ConsultationCallsPurged';
    try {
      if (calls) validatePurgedCallsEvent(input);
      else validatePurgedCardsEvent(input);
    } catch {
      throw new HttpException(
        { error: calls ? 'INVALID_PURGED_CALLS' : 'INVALID_PURGED_CARDS' },
        422,
      );
    }
    try {
      return await this.receiveEvent(input, authorization);
    } catch (error: unknown) {
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
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() input: unknown) {
    if (
      input &&
      typeof input === 'object' &&
      'eventType' in input &&
      input.eventType === 'CustomerOrderReferencesReadRequested'
    ) {
      try {
        validateRetainedCustomersQuery(input);
      } catch {
        throw new HttpException({ error: 'INVALID_CUSTOMER_ORDER_REFERENCES' }, 422);
      }
      const { rows } = await this.database.referencePool.query<{ customer_seq: number }>(
        'SELECT DISTINCT customer_seq FROM orders WHERE customer_seq=ANY($1::int[]) ORDER BY customer_seq',
        [input.payload.ids],
      );
      return {
        eventId: input.eventId,
        status: 'processed',
        payload: rows.map((row) => row.customer_seq),
      };
    }
    try {
      validateReferenceQuery(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_REFERENCE_QUERY' }, 422);
    }
    const result = await this.database.pool.query<ReferenceRows['order']>(
      `SELECT order_seq,customer_seq,status,total_amount FROM orders
       WHERE order_seq=ANY($1::int[]) AND deleted_at IS NULL ORDER BY order_seq`,
      [input.payload.ids],
    );
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }
}
