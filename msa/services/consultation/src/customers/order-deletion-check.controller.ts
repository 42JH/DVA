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
import { validateEvent } from '@dva/events';
import { validateRetainedOrdersQuery } from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/order-deletion-check')
export class OrderDeletionCheckController {
  constructor(private readonly database: DatabaseService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() event: unknown) {
    if (
      event !== null &&
      typeof event === 'object' &&
      'eventType' in event &&
      event.eventType === 'OrderRetentionReferencesReadRequested'
    ) {
      try {
        validateRetainedOrdersQuery(event);
      } catch {
        throw new HttpException(
          { error: 'INVALID_ORDER_RETENTION_REFERENCES' },
          422,
        );
      }
      const { rows } = await this.database.referencePool.query<{
        order_seq: number;
      }>(
        'SELECT DISTINCT order_seq FROM call_sessions WHERE order_seq=ANY($1::int[]) ORDER BY order_seq',
        [event.payload.ids],
      );
      return {
        eventId: event.eventId,
        status: 'processed',
        payload: rows.map((row) => row.order_seq),
      };
    }
    try {
      validateEvent(event);
      if (
        event.source !== 'order' ||
        ![
          'OrderDeletionCheckRequested',
          'OrderSubmissionCheckRequested',
        ].includes(event.eventType) ||
        Object.keys(event.payload).join(',') !== 'orderSeq' ||
        !Number.isInteger(event.payload.orderSeq) ||
        Number(event.payload.orderSeq) < 1 ||
        Number(event.payload.orderSeq) > 2147483647
      )
        throw new Error('Invalid deletion check');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_DELETION_CHECK' }, 422);
    }
    const predicate =
      event.eventType === 'OrderSubmissionCheckRequested'
        ? 'order_intake_enabled AND (ended_at IS NULL OR order_finalized_at IS NULL)'
        : 'deleted_at IS NULL AND ended_at IS NULL';
    const { rows } = await this.database.referencePool.query<{
      blocked: boolean;
    }>(
      `SELECT EXISTS(SELECT 1 FROM call_sessions
       WHERE order_seq=$1 AND ${predicate}) AS blocked`,
      [event.payload.orderSeq],
    );
    return { eventId: event.eventId, status: 'processed', payload: rows[0] };
  }
}
