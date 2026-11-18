import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { BillingError, requestBilling, type BillingRolloverEvent } from '@dva/events/billing.cjs';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';

@Injectable()
export class OrganizationBillingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  private endpoint(path: string) {
    const url = this.config.get('ORDER_URL', { infer: true });
    if (!url)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    return url + '/internal/billing/' + path;
  }
  private failure(error: unknown): never {
    if (error instanceof BillingError)
      throw new ApiException(
        error.status,
        error.error.code as ErrorCode,
        error.error.message,
        error.error.details,
      );
    throw new ApiException(
      503,
      'DEPENDENCY_UNAVAILABLE',
      '서비스를 일시적으로 사용할 수 없습니다.',
    );
  }
  async read(id: number, month?: string) {
    return this.database.transaction(async (client) => {
      const company = (
        await client.query<{ name: string }>(
          'SELECT name FROM organizations WHERE organization_seq=$1 AND deleted_at IS NULL FOR SHARE',
          [id],
        )
      ).rows[0];
      try {
        return await requestBilling(
          this.endpoint('read'),
          this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
          {
            eventId: randomUUID(),
            source: 'customer',
            eventType: 'BillingReadRequested',
            payload: { id, month: month ?? null, organizationName: company?.name ?? null },
          },
        );
      } catch (error) {
        this.failure(error);
      }
    });
  }
  async companies() {
    return (
      await this.database.pool.query<{ id: number }>(
        'SELECT organization_seq AS id FROM organizations WHERE deleted_at IS NULL ORDER BY organization_seq',
      )
    ).rows.map((row) => row.id);
  }
  async rollover(event: BillingRolloverEvent) {
    return this.database.transaction(async (client) => {
      const organizations = (
        await client.query<{ organizationSeq: number; name: string }>(
          `SELECT organization_seq AS "organizationSeq",name FROM organizations
           WHERE organization_seq=ANY($1::integer[]) AND deleted_at IS NULL ORDER BY organization_seq FOR SHARE`,
          [event.payload.months.map((row) => row.organizationSeq)],
        )
      ).rows;
      try {
        return await requestBilling(
          this.endpoint('initialize'),
          this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
          {
            ...event,
            source: 'customer',
            payload: { months: event.payload.months, organizations },
          },
        );
      } catch (error) {
        this.failure(error);
      }
    });
  }
}
