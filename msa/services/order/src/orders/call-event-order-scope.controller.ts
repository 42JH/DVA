import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Post,
  Res,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  requestPacket,
  validateDirective,
  validateScopeRequest,
} from '@dva/events/call-event-reference.cjs';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/call-event-order-scope')
export class CallEventOrderScopeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    try {
      validateScopeRequest(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_EVENT_ORDER_SCOPE' }, 422);
    }
    const callback = new URL(this.config.get('CONSULTATION_URL', { infer: true }));
    if (input.payload.callbackAddress) callback.hostname = input.payload.callbackAddress;
    callback.pathname = '/internal/call-event-order-scope/continue';
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    response.once('close', disconnect);
    try {
      await this.database.transaction(async (client) => {
        let lookup = input.payload.lookup;
        for (let step = 0; step < 50; step++) {
          const { rows } = await client.query<{ allowed: boolean | null }>(
            `SELECT o.order_seq=$2 OR o.customer_seq=COALESCE(
              (SELECT customer_seq FROM orders WHERE order_seq=$2 AND deleted_at IS NULL
                AND COALESCE(closed_at,created_at)>clock_timestamp()-interval '5 years'),$3::int) AS allowed
             FROM orders o WHERE o.order_seq=$1 AND o.deleted_at IS NULL
               AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years' FOR SHARE OF o`,
            [lookup.orderSeq, lookup.callOrderSeq, lookup.customerSeq],
          );
          const directive = await requestPacket(
            callback.origin + callback.pathname,
            this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
            {
              eventId: randomUUID(),
              source: 'order',
              eventType: 'CallEventOrderChecked',
              payload: {
                scopeId: input.eventId,
                step,
                lookup,
                exists: rows.length === 1,
                allowed: rows[0]?.allowed ?? null,
              },
            },
            AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
          );
          validateDirective(directive);
          if (directive.next === null) return;
          lookup = directive.next;
        }
        throw new HttpException({ error: 'CALL_EVENT_ORDER_SCOPE_LIMIT' }, 422);
      });
      return { eventId: input.eventId, status: 'processed', payload: null };
    } finally {
      response.off('close', disconnect);
    }
  }
}
