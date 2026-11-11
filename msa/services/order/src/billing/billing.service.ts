import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  requestBilling,
  type BillingMonth,
  type BillingRolloverEvent,
  type BillingView,
  type CustomerBillingView,
} from '@dva/events/billing.cjs';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';

@Injectable()
export class BillingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async readCustomer(id: number, month: string | null): Promise<CustomerBillingView> {
    return (
      await this.database.pool.query<CustomerBillingView>(
        `SELECT $1::integer AS "customerSeq",to_char(m.month,'YYYY-MM') AS month,
         coalesce(sum(b.amount),0)::float8 AS "monthlyAmount"
         FROM (SELECT coalesce(to_date($2,'YYYY-MM'),
          date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) AS month) m
         LEFT JOIN order_billing_charges b ON b.customer_seq=$1 AND b.billing_month=m.month
         GROUP BY m.month`,
        [id, month],
      )
    ).rows[0];
  }

  async read(id: number, month: string | null, organizationName: string | null) {
    const result = (
      await this.database.pool.query<BillingView>(
        `WITH organizations AS (SELECT $1::integer AS organization_seq,$3::text AS name WHERE $3::text IS NOT NULL)
       SELECT coalesce(o.organization_seq,b.organization_seq) AS "organizationSeq",
       coalesce(b.organization_name,o.name) AS "organizationName",to_char(m.month,'YYYY-MM') AS month,
       coalesce(b.monthly_amount,0)::float8 AS "monthlyAmount",coalesce(b.group_billing_amount,0)::float8 AS "groupBillingAmount"
       FROM (SELECT coalesce(to_date($2,'YYYY-MM'),date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) AS month) m
       LEFT JOIN organizations o ON o.organization_seq=$1
       LEFT JOIN organization_billing_months b ON b.organization_seq=$1 AND b.billing_month=m.month
       WHERE o.organization_seq IS NOT NULL OR b.organization_seq IS NOT NULL`,
        [id, month, organizationName],
      )
    ).rows[0];
    if (!result) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
    return result;
  }

  async rollover(now = new Date()) {
    const url = this.config.get('CUSTOMER_URL', { infer: true });
    const token = this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
    const ids = await requestBilling(url + '/internal/billing/companies', token, {
      eventId: randomUUID(),
      source: 'order',
      eventType: 'BillingOrganizationsReadRequested',
      payload: {},
    });
    const months = (
      await this.database.pool.query<BillingMonth>(
        `SELECT o.organization_seq AS "organizationSeq",m.month::date::text AS "billingMonth"
       FROM unnest($2::integer[]) o(organization_seq)
       LEFT JOIN (SELECT organization_seq,max(billing_month) AS last_month FROM organization_billing_months GROUP BY organization_seq) b USING(organization_seq)
       CROSS JOIN LATERAL generate_series(coalesce(b.last_month+interval '1 month',date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Seoul')),
         date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Seoul'),interval '1 month') m(month)
       ORDER BY o.organization_seq,m.month`,
        [now, ids],
      )
    ).rows;
    for (let offset = 0; offset < months.length; offset += 10) {
      // No order connection is held while customer locks companies and calls back.
      const acquired = await requestBilling(url + '/internal/billing/rollover', token, {
        eventId: randomUUID(),
        source: 'order',
        eventType: 'BillingRolloverRequested',
        payload: { months: months.slice(offset, offset + 10) },
      });
      if (!acquired) return;
    }
  }

  async initialize(event: BillingRolloverEvent) {
    return this.database.transaction(async (client) => {
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261030,139) AS locked',
          )
        ).rows[0].locked
      )
        return false;
      for (const month of event.payload.months) {
        const company = event.payload.organizations!.find(
          (row) => row.organizationSeq === month.organizationSeq,
        );
        if (!company) continue;
        const created = await client.query(
          `INSERT INTO organization_billing_months(organization_seq,billing_month,organization_name)
           VALUES($1,$2::date,$3) ON CONFLICT DO NOTHING RETURNING organization_seq`,
          [month.organizationSeq, month.billingMonth, company.name],
        );
        if (!created.rowCount) continue;
        const previous = (
          await client.query<{ monthlyAmount: number; groupBillingAmount: number }>(
            `SELECT monthly_amount::float8 AS "monthlyAmount",group_billing_amount::float8 AS "groupBillingAmount"
           FROM organization_billing_months WHERE organization_seq=$1 AND billing_month<$2::date ORDER BY billing_month DESC LIMIT 1`,
            [month.organizationSeq, month.billingMonth],
          )
        ).rows[0] ?? { monthlyAmount: 0, groupBillingAmount: 0 };
        const requestId = randomUUID();
        for (const [paymentMethodType, amountBefore] of [
          ['credit', previous.monthlyAmount],
          ['groupBilling', previous.groupBillingAmount],
        ] as const)
          await this.audit.recordSuccess(
            {
              actorId: null,
              actorType: 'SYSTEM',
              targetId: month.organizationSeq,
              targetType: 'ORGANIZATION',
              action: 'BILLING_MONTH_INITIALIZED',
              requestId,
              metadata: {
                billingMonth: month.billingMonth.slice(0, 7),
                paymentMethodType,
                amountBefore,
                amountAfter: 0,
              },
            },
            client,
          );
      }
      return true;
    });
  }
}
