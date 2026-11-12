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
import {
  validateReferenceQuery,
  validateRetainedCustomersQuery,
  type ReferenceRows,
} from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/call-read-references')
export class CallReadReferencesController {
  constructor(private readonly database: DatabaseService) {}
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
