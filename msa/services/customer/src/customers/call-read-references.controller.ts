import { OrderReferenceScopes } from './order-reference-scopes.service';
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
import { Pool, PoolClient } from 'pg';
import { validateDraftRead, requestDraftReadCall } from '@dva/events/parcel-drafts.cjs';
import { requestDraftRead } from '@dva/events/order-read.cjs';
import { retryReadSnapshot, validateReadScope, readCallbackUrl } from '@dva/events/read-scope.cjs';
import {
  validateAdminOrderRead,
  requestAdminOrderRead,
  OrderReadError,
} from '@dva/events/order-read.cjs';
import {
  validateOrderOrganizationQuery,
  type OrderOrganization,
} from '@dva/events/call-read-references.cjs';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateReferenceQuery, type ReferenceRows } from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/call-read-references')
export class CallReadReferencesController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly reads: OrderReferenceScopes,
  ) {}

  @Post('parcel-drafts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftRead(@Body() event: unknown) {
    try {
      validateDraftRead(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_READ' }, 422);
    }
    try {
      const id = event.payload.command.callSessionSeq;
      const token = this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
      const call =
        id === null
          ? null
          : await requestDraftReadCall(
              readCallbackUrl(
                this.config.get('CONSULTATION_URL', { infer: true }),
                '/internal/parcel-draft-read/call',
                event.payload.consultationAddress ?? null,
              ),
              token,
              id,
              event.eventId,
              'customer',
            );
      return await retryReadSnapshot(() =>
        this.database.transaction(async (client) => {
          await client.query(
            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ' + (call === null ? ' READ ONLY' : ''),
          );
          await client.query('SELECT 1');
          let customerSeq: number | null = null;
          if (call) {
            if (!call.callerPhoneNumber)
              throw new ApiException(
                403,
                'FORBIDDEN',
                '통화 발신번호와 활성 고객 연결을 확인해 주세요.',
              );
            const customer = (
              await client.query<{ id: number }>(
                call.customerSeq === null
                  ? "SELECT customer_seq AS id FROM customers WHERE phone_number=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR SHARE"
                  : "SELECT customer_seq AS id FROM customers WHERE customer_seq=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR SHARE",
                [call.customerSeq ?? call.callerPhoneNumber],
              )
            ).rows[0];
            if (call.customerSeq !== null && !customer)
              throw new ApiException(
                403,
                'FORBIDDEN',
                '통화 발신번호와 활성 고객 연결을 확인해 주세요.',
              );
            customerSeq = customer?.id ?? null;
          }
          return this.reads.run(event.eventId, client, async () => {
            const payload = await requestDraftRead(
              readCallbackUrl(
                this.config.get('ORDER_URL', { infer: true }),
                '/internal/parcel-draft-read',
                event.payload.orderAddress,
              ),
              token,
              {
                ...event,
                source: 'customer',
                payload: {
                  ...event.payload,
                  customerSeq,
                  customerAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
                },
              },
            );
            return { eventId: event.eventId, status: 'processed', payload };
          });
        }),
      );
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new HttpException({ error: error.error }, error.status);
      if (error instanceof ApiException)
        throw new HttpException({ error: error.getResponse() }, error.getStatus());
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  @Post('admin-orders')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async adminOrders(@Body() event: unknown) {
    try {
      validateAdminOrderRead(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_ADMIN_ORDER_READ' }, 422);
    }
    try {
      return await this.database.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query('SELECT 1');
        return this.reads.run(event.eventId, client, async () => {
          const payload = await requestAdminOrderRead(
            readCallbackUrl(
              this.config.get('ORDER_URL', { infer: true }),
              '/internal/admin-order-read',
              event.payload.orderAddress,
            ),
            this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
            {
              ...event,
              source: 'customer',
              payload: {
                ...event.payload,
                customerAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
              },
            },
          );
          return { eventId: event.eventId, status: 'processed', payload };
        });
      });
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new HttpException({ error: error.error }, error.status);
      if (error instanceof ApiException) throw error;
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  @Post('order-organization')
  @SetMetadata('auth:internal-operations', true)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async organization(@Body() input: unknown, @Headers('x-msa-read-scope') scopeId?: string) {
    try {
      validateOrderOrganizationQuery(input);
      if (scopeId !== undefined) validateReadScope(scopeId);
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_ORGANIZATION_QUERY' }, 422);
    }
    const work = async (client: Pool | PoolClient) =>
      (
        await client.query<OrderOrganization>(
          `SELECT $1::int AS organization_seq,o.name AS organization_name,
       ARRAY(SELECT c.customer_seq FROM customers c JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
         WHERE c.deleted_at IS NULL AND m.organization_seq=o.organization_seq ORDER BY c.customer_seq) AS customer_seqs
       FROM (SELECT 1) seed LEFT JOIN organizations o ON o.organization_seq=$1 AND o.deleted_at IS NULL`,
          [input.payload.organizationSeq],
        )
      ).rows[0];
    const payload =
      scopeId === undefined ? await work(this.database.pool) : await this.reads.use(scopeId, work);
    return { eventId: input.eventId, status: 'processed', payload };
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  query(@Body() input: unknown) {
    return this.read(input, 'consultation');
  }

  @Post('for-orders')
  @SetMetadata('auth:internal-operations', true)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  forOrders(@Body() input: unknown, @Headers('x-msa-read-scope') scopeId?: string) {
    return this.read(input, 'order', scopeId);
  }

  private async read(input: unknown, source: 'consultation' | 'order', scopeId?: string) {
    try {
      validateReferenceQuery(input, source);
      if (scopeId !== undefined) validateReadScope(scopeId);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_REFERENCE_QUERY' }, 422);
    }
    const work = (client: Pool | PoolClient) =>
      client.query<ReferenceRows['customer']>(
        `SELECT c.customer_seq,c.name,o.organization_seq,o.name AS organization_name FROM customers c
       LEFT JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
       LEFT JOIN organizations o ON o.organization_seq=m.organization_seq AND o.deleted_at IS NULL
       WHERE c.customer_seq=ANY($1::int[]) AND c.deleted_at IS NULL ORDER BY c.customer_seq`,
        [input.payload.ids],
      );
    const result =
      scopeId === undefined ? await work(this.database.pool) : await this.reads.use(scopeId, work);
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }
}
