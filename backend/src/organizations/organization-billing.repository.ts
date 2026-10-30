import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { BillingMonthDto } from './dto/billing-month.dto';

@Injectable()
export class OrganizationBillingRepository {
  constructor(private readonly database: DatabaseService) {}
  async read(id: number, month?: string) {
    return (
      await this.database.pool.query<BillingMonthDto>(
        `SELECT o.organization_seq AS "organizationSeq",to_char(m.month,'YYYY-MM') AS month,
       coalesce(b.monthly_amount,0)::float8 AS "monthlyAmount",coalesce(b.group_billing_amount,0)::float8 AS "groupBillingAmount"
       FROM organizations o CROSS JOIN LATERAL (SELECT coalesce(to_date($2,'YYYY-MM'),date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) AS month) m
       LEFT JOIN organization_billing_months b ON b.organization_seq=o.organization_seq AND b.billing_month=m.month WHERE o.organization_seq=$1`,
        [id, month ?? null],
      )
    ).rows[0];
  }
  async ensureMonth(client: PoolClient, id: number, month: string) {
    const created = await client.query(
      `INSERT INTO organization_billing_months(organization_seq,billing_month) VALUES($1,$2::date) ON CONFLICT DO NOTHING RETURNING organization_seq`,
      [id, month],
    );
    if (!created.rowCount) return undefined;
    return (
      (
        await client.query<{ monthlyAmount: number; groupBillingAmount: number }>(
          `SELECT monthly_amount::float8 AS "monthlyAmount",group_billing_amount::float8 AS "groupBillingAmount"
      FROM organization_billing_months WHERE organization_seq=$1 AND billing_month<$2::date ORDER BY billing_month DESC LIMIT 1`,
          [id, month],
        )
      ).rows[0] ?? { monthlyAmount: 0, groupBillingAmount: 0 }
    );
  }
  async insertCharge(client: PoolClient, id: number) {
    return (
      await client.query<{
        organizationSeq: number;
        billingMonth: string;
        paymentMethodType: 'credit' | 'groupBilling';
        amount: number;
      }>(
        `INSERT INTO order_billing_charges(order_seq,organization_seq,billing_month,payment_method_type,amount,occurred_at)
       SELECT order_seq,billing_organization_seq,date_trunc('month',paid_at AT TIME ZONE 'Asia/Seoul')::date,payment_method_type,total_amount,paid_at FROM orders
       WHERE order_seq=$1 AND paid_at IS NOT NULL AND billing_organization_seq IS NOT NULL AND payment_method_type IN ('credit','groupBilling')
       ON CONFLICT(order_seq) DO NOTHING RETURNING organization_seq AS "organizationSeq",billing_month::text AS "billingMonth",payment_method_type AS "paymentMethodType",amount`,
        [id],
      )
    ).rows[0];
  }
  async increment(
    client: PoolClient,
    id: number,
    month: string,
    method: 'credit' | 'groupBilling',
    amount: number,
  ) {
    const column = method === 'credit' ? 'monthly_amount' : 'group_billing_amount';
    return (
      await client.query<{ amountBefore: number; amountAfter: number }>(
        `UPDATE organization_billing_months SET ${column}=${column}+$3 WHERE organization_seq=$1 AND billing_month=$2::date
      RETURNING (${column}-$3)::float8 AS "amountBefore",${column}::float8 AS "amountAfter"`,
        [id, month, amount],
      )
    ).rows[0];
  }
  async missingMonths(client: PoolClient, now: Date) {
    return (
      await client.query<{ organizationSeq: number; billingMonth: string }>(
        `SELECT o.organization_seq AS "organizationSeq",m.month::date::text AS "billingMonth"
      FROM organizations o LEFT JOIN (SELECT organization_seq,max(billing_month) AS last_month FROM organization_billing_months GROUP BY organization_seq) b USING(organization_seq)
      CROSS JOIN LATERAL generate_series(coalesce(b.last_month+interval '1 month',date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Seoul')),
        date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Seoul'),interval '1 month') m(month)
      ORDER BY o.organization_seq,m.month`,
        [now],
      )
    ).rows;
  }
}
