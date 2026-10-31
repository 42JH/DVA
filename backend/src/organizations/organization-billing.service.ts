import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { OrganizationBillingRepository } from './organization-billing.repository';

@Injectable()
export class OrganizationBillingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrganizationBillingRepository,
    private readonly audit: AuditService,
  ) {}
  async read(id: number, month?: string) {
    const result = await this.repository.read(id, month);
    if (!result) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
    return result;
  }
  private async ensureMonth(client: PoolClient, id: number, month: string, requestId: string) {
    const previous = await this.repository.ensureMonth(client, id, month);
    if (previous === undefined) return;
    for (const [paymentMethodType, amountBefore] of [
      ['credit', previous.monthlyAmount],
      ['groupBilling', previous.groupBillingAmount],
    ] as const)
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'SYSTEM',
          targetId: id,
          targetType: 'ORGANIZATION',
          action: 'BILLING_MONTH_INITIALIZED',
          requestId,
          metadata: {
            billingMonth: month.slice(0, 7),
            paymentMethodType,
            amountBefore,
            amountAfter: 0,
          },
        },
        client,
      );
  }
  async recordCharge(client: PoolClient, orderId: number, requestId: string) {
    const charge = await this.repository.insertCharge(client, orderId);
    if (!charge) return;
    await this.ensureMonth(client, charge.organizationSeq, charge.billingMonth, requestId);
    const change = await this.repository.increment(
      client,
      charge.organizationSeq,
      charge.billingMonth,
      charge.paymentMethodType,
      charge.amount,
    );
    await this.audit.recordSuccess(
      {
        actorId: null,
        actorType: 'SYSTEM',
        targetId: charge.organizationSeq,
        targetType: 'ORGANIZATION',
        action: 'BILLING_AMOUNT_INCREASED',
        requestId,
        metadata: {
          billingMonth: charge.billingMonth.slice(0, 7),
          paymentMethodType: charge.paymentMethodType,
          ...change,
        },
      },
      client,
    );
  }
  async rollover(now = new Date()) {
    const months = await this.repository.missingMonths(this.database.pool, now);
    for (let offset = 0; offset < months.length; offset += 10) {
      const acquired = await this.database.transaction(async (client) => {
        if (
          !(
            await client.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_xact_lock(20261030,139) AS locked',
            )
          ).rows[0].locked
        )
          return false;
        for (const month of months.slice(offset, offset + 10)) {
          // Serialize month creation with company deletion, including after its billing FKs are removed.
          const company = await client.query(
            'SELECT 1 FROM organizations WHERE organization_seq=$1 FOR SHARE',
            [month.organizationSeq],
          );
          if (company.rowCount)
            await this.ensureMonth(client, month.organizationSeq, month.billingMonth, randomUUID());
        }
        return true;
      });
      if (!acquired) return;
    }
  }
}
