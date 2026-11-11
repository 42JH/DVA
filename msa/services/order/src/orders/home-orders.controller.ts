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
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { requestDraftCallReferences } from '@dva/events/parcel-drafts.cjs';
import {
  validateHomeOrdersQuery,
  type HomeOrdersQuery,
} from '@dva/events/call-read-references.cjs';
import { readCallbackUrl, validateReadScope } from '@dva/events/read-scope.cjs';
import { ListResponse } from '../common/pagination';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AdminOrderListQueryDto } from './dto/admin-order-list.dto';
import { ParcelDraftQueryDto } from './dto/parcel-draft.dto';
import { OrdersRepository } from './orders.repository';
import { ParcelDraftReadsRepository } from './parcel-draft-reads.repository';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/home-orders')
export class HomeOrdersController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly orders: OrdersRepository,
    private readonly drafts: ParcelDraftReadsRepository,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async read(@Body() event: unknown, @Headers('x-msa-read-scope') scopeId: string) {
    try {
      validateHomeOrdersQuery(event);
      validateReadScope(scopeId);
    } catch {
      throw new HttpException({ error: 'INVALID_HOME_ORDERS_QUERY' }, 422);
    }
    return {
      eventId: event.eventId,
      status: 'processed',
      payload: await this.snapshot(event, scopeId),
    };
  }

  private snapshot(event: HomeOrdersQuery, scopeId: string) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const counts = await this.orders.adminStatusCounts(
        client,
        new AdminOrderListQueryDto(),
        null,
      );
      const query = Object.assign(new ParcelDraftQueryDto(), { limit: 11 });
      const drafts = await this.drafts.list(client, query, null, null, null, null, (input) =>
        requestDraftCallReferences(
          readCallbackUrl(
            this.config.get('CONSULTATION_URL', { infer: true }),
            '/internal/order-draft-call-references',
            event.payload.consultationAddress,
          ),
          this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
          input,
          scopeId,
        ),
      );
      const { count } = (
        await client.query<{ count: number }>(
          `WITH day AS (SELECT ($1::timestamptz AT TIME ZONE 'Asia/Seoul')::date AS date),
         bounds AS (SELECT date::timestamp AT TIME ZONE 'Asia/Seoul' AS from_at,
          (date+1)::timestamp AT TIME ZONE 'Asia/Seoul' AS to_at FROM day)
         SELECT count(*)::float8 AS count FROM orders o CROSS JOIN bounds b
         WHERE o.created_at>=b.from_at AND o.created_at<b.to_at AND o.deleted_at IS NULL
          AND COALESCE(o.closed_at,o.created_at)>transaction_timestamp()-interval '5 years'
          AND NOT EXISTS(SELECT 1 FROM order_parcel_drafts d WHERE d.legacy_order_seq=o.order_seq)`,
          [event.payload.observedAt],
        )
      ).rows[0];
      return {
        todayOrderCount: count,
        notPaid: counts.notPaid,
        submissionFailed: counts.submissionFailed,
        drafts: new ListResponse(drafts, 11),
      };
    });
  }
}
