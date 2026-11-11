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
import {
  requestDraftWrite,
  validateDraftWrite,
  validateWriteReference,
  type CustomerReference,
} from '@dva/events/parcel-draft-write.cjs';
import type { PoolClient } from 'pg';
import { OrderReadError } from '@dva/events/order-read.cjs';
import { readCallbackUrl, validateReadScope } from '@dva/events/read-scope.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { OrderReferenceScopes } from './order-reference-scopes.service';

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/call-read-references/parcel-draft-write')
export class ParcelDraftWriteController {
  private readonly active = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly scopes: OrderReferenceScopes,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Body() event: unknown) {
    try {
      validateDraftWrite(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_WRITE' }, 422);
    }
    try {
      return await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        return this.scopes.run(event.eventId, client, async () => {
          this.active.add(event.eventId);
          try {
            const payload = await requestDraftWrite(
              readCallbackUrl(
                this.config.get('ORDER_URL', { infer: true }) ?? '',
                '/internal/parcel-draft-write',
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
          } finally {
            this.active.delete(event.eventId);
          }
        });
      });
    } catch (error) {
      this.failure(error);
    }
  }

  @Post('reference')
  @SetMetadata('auth:internal-operations', true)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reference(@Body() event: unknown, @Headers('x-msa-read-scope') scopeId: string) {
    try {
      validateWriteReference(event);
      validateReadScope(scopeId);
      if (
        event.source !== 'order' ||
        !['CustomerRead', 'CustomerPhoneRead', 'PinChecked', 'CustomerPaymentPolicyRead'].includes(
          event.payload.operation,
        )
      )
        throw new Error('Invalid customer write reference');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
    }
    if (!this.active.has(scopeId))
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    try {
      const payload = await this.scopes.use(scopeId, async (client) => {
        const input = event.payload.input;
        if (event.payload.operation === 'CustomerPaymentPolicyRead')
          return this.paymentPolicy(client, Number(input.id));
        if (event.payload.operation === 'PinChecked')
          return (
            (
              await client.query(
                'SELECT 1 FROM personal_pins WHERE personal_pin_seq=$1 AND customer_seq=$2 AND deleted_at IS NULL FOR SHARE',
                [input.pinSeq, input.customerSeq],
              )
            ).rowCount !== 0
          );
        return (
          (
            await client.query<CustomerReference>(
              `SELECT customer_seq AS "customerSeq",phone_number AS phone,status='ACTIVE' AND deleted_at IS NULL AS active
             FROM customers WHERE ${
               event.payload.operation === 'CustomerRead'
                 ? 'customer_seq=$1'
                 : "phone_number=$1 AND status='ACTIVE' AND deleted_at IS NULL"
             } FOR SHARE`,
              [event.payload.operation === 'CustomerRead' ? input.id : input.phone],
            )
          ).rows[0] ?? null
        );
      });
      return { eventId: event.eventId, status: 'processed', payload };
    } catch (error) {
      this.failure(error);
    }
  }

  private async paymentPolicy(client: PoolClient, customerId: number) {
    const customer = (
      await client.query<{ monthlyBillingEnabled: boolean }>(
        `SELECT monthly_billing_enabled AS "monthlyBillingEnabled" FROM customers WHERE customer_seq=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR SHARE`,
        [customerId],
      )
    ).rows[0];
    const member = (
      await client.query<{
        organizationSeq: number;
        organizationName: string;
        departmentSeq: number | null;
        membershipStatus: string;
        organizationStatus: string;
        monthlyBillingEnabled: boolean;
      }>(
        `SELECT o.name AS "organizationName",m.organization_seq AS "organizationSeq",m.department_seq AS "departmentSeq",m.status AS "membershipStatus",o.status AS "organizationStatus",
       o.monthly_billing_enabled AS "monthlyBillingEnabled"
       FROM memberships m JOIN organizations o USING(organization_seq)
       WHERE m.customer_seq=$1 AND m.deleted_at IS NULL AND o.deleted_at IS NULL FOR SHARE OF m,o`,
        [customerId],
      )
    ).rows[0];
    const department =
      member?.departmentSeq != null
        ? (
            await client.query<{
              groupBillingEnabled: boolean;
              name: string;
              deletedAt: string | null;
            }>(
              'SELECT name,deleted_at AS "deletedAt",group_billing_enabled AS "groupBillingEnabled" FROM departments WHERE department_seq=$1 FOR SHARE',
              [member.departmentSeq],
            )
          ).rows[0]
        : undefined;
    const active = member?.membershipStatus === 'ACTIVE' && member.organizationStatus === 'ACTIVE';
    return {
      monthly:
        !!customer &&
        (member ? active && member.monthlyBillingEnabled : customer.monthlyBillingEnabled),
      group:
        !!customer &&
        !!active &&
        department?.deletedAt === null &&
        department.groupBillingEnabled === true,
      organizationName: active ? member.organizationName : null,
      departmentName: active ? (department?.name ?? null) : null,
      organizationSeq: active ? member.organizationSeq : null,
      departmentSeq: active ? member.departmentSeq : null,
    };
  }

  private failure(error: unknown): never {
    if (error instanceof ApiException) throw error;
    if (error instanceof OrderReadError)
      throw new ApiException(
        error.status,
        error.error.code as ErrorCode,
        error.error.message,
        error.error.details,
      );
    if (error instanceof Error && 'code' in error) {
      if (error.code === '55P03')
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '다른 작업의 완료 대기 시간을 초과했습니다. 잠시 후 재시도해 주세요.',
        );
      throw error;
    }
    throw new ApiException(
      503,
      'DEPENDENCY_UNAVAILABLE',
      '서비스를 일시적으로 사용할 수 없습니다.',
    );
  }
}
