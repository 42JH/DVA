import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer-request.dto';
import { Customer, EmployeeCustomerIdentity } from './customers.types';
import { CallerContextDto } from './dto/caller-context.dto';
import { CustomerListItemDto } from './dto/customer-response.dto';
import { CustomerBillingMonthDto } from './dto/customer-billing-month.dto';

const columns =
  'customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status,monthly_billing_enabled AS "monthlyBillingEnabled",address_data AS address';

const availablePaymentMethods = `CASE WHEN c.status<>'ACTIVE' THEN '[]'::jsonb ELSE
  '["billing"]'::jsonb || CASE WHEN
    (m.membership_seq IS NULL AND c.monthly_billing_enabled)
    OR (m.status='ACTIVE' AND o.status='ACTIVE' AND o.monthly_billing_enabled AND m.monthly_billing_enabled)
    THEN '["credit"]'::jsonb ELSE '[]'::jsonb END
  || CASE WHEN m.status='ACTIVE' AND o.status='ACTIVE' AND m.group_billing_enabled AND EXISTS(SELECT 1 FROM payment_cards pc WHERE pc.organization_seq=o.organization_seq AND pc.status='ACTIVE' AND pc.deleted_at IS NULL AND pc.expiration_year*12+pc.expiration_month>=extract(year FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul')*12+extract(month FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul'))
    THEN '["groupBilling"]'::jsonb ELSE '[]'::jsonb END END`;

@Injectable()
export class CustomersRepository {
  async lockMany(client: PoolClient, ids: number[]): Promise<number[]> {
    const result = await client.query<{ id: number }>(
      'SELECT customer_seq AS id FROM customers WHERE customer_seq=ANY($1::int[]) AND deleted_at IS NULL ORDER BY customer_seq FOR UPDATE',
      [ids],
    );
    return result.rows.map((row) => row.id);
  }

  async removeMany(client: PoolClient, ids: number[]): Promise<void> {
    await client.query(
      'UPDATE memberships SET deleted_at=clock_timestamp() WHERE customer_seq=ANY($1::int[]) AND deleted_at IS NULL',
      [ids],
    );
    await client.query(
      'UPDATE personal_pins SET deleted_at=clock_timestamp() WHERE customer_seq=ANY($1::int[]) AND deleted_at IS NULL',
      [ids],
    );
    await client.query(
      'UPDATE customers SET deleted_at=clock_timestamp() WHERE customer_seq=ANY($1::int[]) AND deleted_at IS NULL',
      [ids],
    );
  }

  async claimRelatedDeletion(): Promise<number | undefined> {
    return (
      await this.database.pool.query<{ id: number }>(
        "UPDATE customers SET related_deletion_due_at=clock_timestamp()+interval '1 minute' WHERE customer_seq=(SELECT customer_seq FROM customers WHERE related_deletion_due_at<=statement_timestamp() ORDER BY related_deletion_due_at,customer_seq LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING customer_seq AS id",
      )
    ).rows[0]?.id;
  }

  async lockRelatedDeletion(client: PoolClient, id: number): Promise<string | undefined> {
    return (
      await client.query<{ deletedAt: string }>(
        'SELECT deleted_at::text AS "deletedAt" FROM customers WHERE customer_seq=$1 AND deleted_at IS NOT NULL AND related_deletion_due_at IS NOT NULL FOR UPDATE',
        [id],
      )
    ).rows[0]?.deletedAt;
  }

  async finishRelatedDeletion(client: PoolClient, id: number): Promise<void> {
    await client.query('UPDATE customers SET related_deletion_due_at=NULL WHERE customer_seq=$1', [
      id,
    ]);
  }

  async lockRelatedData(client: PoolClient, customerIds: number[], cutoff: string | null) {
    const orders = await client.query<{ id: number }>(
      `SELECT o.order_seq AS id FROM orders o
       WHERE (o.customer_seq=ANY($1::int[]) OR (o.customer_seq IS NULL AND EXISTS(
         SELECT 1 FROM call_sessions c WHERE c.order_seq=o.order_seq AND c.customer_seq=ANY($1::int[]))))
        AND ($2::timestamptz IS NULL OR o.created_at<=$2)
       ORDER BY o.order_seq FOR UPDATE`,
      [customerIds, cutoff],
    );
    const orderIds = orders.rows.map((row) => row.id);
    await client.query(
      'SELECT 1 FROM order_payment_requests WHERE order_seq=ANY($1::int[]) ORDER BY payment_request_id FOR UPDATE',
      [orderIds],
    );
    const calls = await client.query<{ id: number }>(
      `SELECT c.call_session_seq AS id FROM call_sessions c
       WHERE (c.customer_seq=ANY($1::int[]) OR (c.customer_seq IS NULL AND c.order_seq=ANY($2::int[])))
        AND ($3::timestamptz IS NULL OR COALESCE(c.incoming_at,c.started_at,c.registered_at,'-infinity')<=$3)
       ORDER BY c.call_session_seq FOR UPDATE`,
      [customerIds, orderIds, cutoff],
    );
    return { orderIds, callIds: calls.rows.map((row) => row.id) };
  }

  async relatedDataInProgress(
    client: PoolClient,
    orderIds: number[],
    callIds: number[],
    customerIds: number[],
  ) {
    const { rows } = await client.query<{ busy: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM orders o WHERE o.order_seq=ANY($1::int[])
        AND o.deleted_at IS NULL AND o.status IN ('PAID','SUBMITTING','SUBMITTING_FAILED'))
       OR EXISTS(SELECT 1 FROM order_payment_requests r WHERE r.order_seq=ANY($1::int[]) AND
        ((r.approval_started_at IS NOT NULL AND r.invalidated_at IS NULL AND r.completed_at IS NULL)
          OR r.notification_status='SENDING' OR r.completion_notification_status='SENDING'))
       OR EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_session_seq=ANY($2::int[])
        AND c.deleted_at IS NULL AND c.ended_at IS NULL)
       OR EXISTS(SELECT 1 FROM pbx_webhooks.call_ended_events e WHERE e.call_session_seq=ANY($2::int[])
        AND (e.processing_status<>'PROCESSED' OR e.claimed_until>clock_timestamp()))
       OR EXISTS(SELECT 1 FROM payment_cards p WHERE p.customer_seq=ANY($3::int[])
        AND p.status='REGISTERING' AND p.deleted_at IS NULL AND p.claimed_until>clock_timestamp()) AS busy`,
      [orderIds, callIds, customerIds],
    );
    return rows[0].busy;
  }

  async removeRelatedData(
    client: PoolClient,
    customerIds: number[],
    orderIds: number[],
    callIds: number[],
    cutoff: string | null,
  ) {
    await client.query(
      `UPDATE order_payment_requests SET
       notification_status=CASE WHEN notification_status='PENDING' THEN 'FAILED' ELSE notification_status END,
       completion_notification_status=CASE WHEN completion_notification_status IN ('WAITING','PENDING') THEN 'FAILED' ELSE completion_notification_status END
       WHERE order_seq=ANY($1::int[]) AND
        (notification_status='PENDING' OR completion_notification_status IN ('WAITING','PENDING'))`,
      [orderIds],
    );
    const orders = await client.query<{ id: number }>(
      'UPDATE orders SET deleted_at=transaction_timestamp() WHERE order_seq=ANY($1::int[]) AND deleted_at IS NULL RETURNING order_seq AS id',
      [orderIds],
    );
    const calls = await client.query<{ id: number }>(
      'UPDATE call_sessions SET deleted_at=transaction_timestamp() WHERE call_session_seq=ANY($1::int[]) AND deleted_at IS NULL RETURNING call_session_seq AS id',
      [callIds],
    );
    const drafts = await client.query<{ id: number }>(
      `UPDATE order_parcel_drafts d SET deleted_at=transaction_timestamp(),
       version=version+1,updated_at=transaction_timestamp()
       WHERE d.deleted_at IS NULL AND ($4::timestamptz IS NULL OR d.created_at<=$4)
        AND (d.customer_seq=ANY($1::int[]) OR (d.customer_seq IS NULL AND
          (d.order_seq=ANY($2::int[]) OR d.legacy_order_seq=ANY($2::int[]) OR d.call_session_seq=ANY($3::int[]))))
       RETURNING draft_seq AS id`,
      [customerIds, orderIds, callIds, cutoff],
    );
    if (calls.rowCount) await client.query("SELECT pg_notify('call_sessions_changed','')");
    return { orders: orders.rows, calls: calls.rows, drafts: drafts.rows };
  }

  async invalidateUnstartedPayments(client: PoolClient, orderIds: number[]): Promise<number[]> {
    const result = await client.query<{ orderSeq: number }>(
      `UPDATE order_payment_requests r SET invalidated_at=clock_timestamp()
       WHERE r.order_seq=ANY($1::int[])
        AND r.invalidated_at IS NULL AND r.completed_at IS NULL AND r.approval_started_at IS NULL
        AND r.provider_approved_at IS NULL
       RETURNING r.order_seq AS "orderSeq"`,
      [orderIds],
    );
    return [...new Set(result.rows.map((row) => row.orderSeq))];
  }

  constructor(private readonly database: DatabaseService) {}

  async billingMonth(id: number, month?: string) {
    return (
      await this.database.pool.query<CustomerBillingMonthDto>(
        `SELECT c.customer_seq AS "customerSeq",to_char(m.month,'YYYY-MM') AS month,
         coalesce(sum(b.amount),0)::float8 AS "monthlyAmount"
         FROM customers c
         CROSS JOIN (SELECT coalesce(to_date($2,'YYYY-MM'),
          date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) AS month) m
         LEFT JOIN order_billing_charges b ON b.customer_seq=c.customer_seq AND b.billing_month=m.month
         WHERE c.customer_seq=$1 AND c.deleted_at IS NULL
         GROUP BY c.customer_seq,m.month`,
        [id, month ?? null],
      )
    ).rows[0];
  }

  async updateIdentities(client: PoolClient, rows: EmployeeCustomerIdentity[]): Promise<void> {
    if (!rows.length) return;
    await client.query(
      `UPDATE customers c SET name=r.name,phone_number=r."phoneNumber",
       address_data=CASE WHEN r."changeAddress" THEN r.address ELSE c.address_data END
       FROM jsonb_to_recordset($1::jsonb) AS r("customerSeq" int,name text,"phoneNumber" text,address jsonb,"changeAddress" boolean)
       WHERE c.customer_seq=r."customerSeq"
         AND (c.name IS DISTINCT FROM r.name OR c.phone_number IS DISTINCT FROM r."phoneNumber"
           OR (r."changeAddress" AND c.address_data IS DISTINCT FROM r.address))`,
      [JSON.stringify(rows.map((row) => ({ ...row, changeAddress: row.address !== undefined })))],
    );
  }

  async insertIdentities(client: PoolClient, rows: EmployeeCustomerIdentity[]) {
    if (!rows.length) return [];
    return (
      await client.query<{ customerSeq: number; phoneNumber: string }>(
        `INSERT INTO customers(name,phone_number,status,address_data)
         SELECT name,"phoneNumber",'ACTIVE',address FROM jsonb_to_recordset($1::jsonb) AS r(name text,"phoneNumber" text,address jsonb)
         RETURNING customer_seq AS "customerSeq",phone_number AS "phoneNumber"`,
        [JSON.stringify(rows)],
      )
    ).rows;
  }

  async context(phoneNumber: string, client?: PoolClient): Promise<CallerContextDto> {
    // 한 SQL 문장의 스냅샷으로 고객·소속 상태와 허용 주소록을 함께 읽는다.
    const result = await (client ?? this.database.pool).query<{ context: CallerContextDto }>(
      `SELECT jsonb_build_object(
        'lookupStatus', CASE WHEN c.status='ACTIVE' THEN 'REGISTERED' ELSE 'WITHDRAWN' END,
        'customer', CASE WHEN c.status='ACTIVE' THEN jsonb_build_object(
          'customerSeq',c.customer_seq,'name',c.name,'phoneNumber',c.phone_number,'status',c.status,'monthlyBillingEnabled',c.monthly_billing_enabled,'address',c.address_data) END,
        'membership', CASE WHEN c.status='ACTIVE' AND m.membership_seq IS NOT NULL THEN jsonb_build_object(
          'membershipSeq',m.membership_seq,'customerSeq',m.customer_seq,'organizationSeq',m.organization_seq,
          'employeeNo',m.employee_no,'role',m.role,'status',m.status,'departmentSeq',m.department_seq,'monthlyBillingEnabled',m.monthly_billing_enabled,'groupBillingEnabled',m.group_billing_enabled) END,
        'organization', CASE WHEN c.status='ACTIVE' AND o.organization_seq IS NOT NULL THEN jsonb_build_object(
          'organizationSeq',o.organization_seq,'name',o.name,'status',o.status,'monthlyBillingEnabled',o.monthly_billing_enabled,
          'groupCardRegistered',EXISTS(SELECT 1 FROM payment_cards pc WHERE pc.organization_seq=o.organization_seq AND pc.status='ACTIVE' AND pc.deleted_at IS NULL AND pc.expiration_year*12+pc.expiration_month>=extract(year FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul')*12+extract(month FROM clock_timestamp() AT TIME ZONE 'Asia/Seoul'))) END,
        'department',CASE WHEN c.status='ACTIVE' AND d.department_seq IS NOT NULL THEN jsonb_build_object(
          'departmentSeq',d.department_seq,'organizationSeq',d.organization_seq,'name',d.name,'groupBillingEnabled',d.group_billing_enabled) END,
        'availablePaymentMethods',${availablePaymentMethods},
        'availableUsageTypes', CASE
          WHEN c.status<>'ACTIVE' THEN '[]'::jsonb
          WHEN m.status='ACTIVE' AND o.status='ACTIVE' THEN '["PERSONAL","COMPANY"]'::jsonb
          ELSE '["PERSONAL"]'::jsonb END,
        'personalPins', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'personalPinSeq',p.personal_pin_seq,'label',p.label,'addressData',p.address_data,'version',p.version)
          ORDER BY p.personal_pin_seq)
          FROM personal_pins p WHERE p.customer_seq=c.customer_seq AND p.deleted_at IS NULL AND c.status='ACTIVE'), '[]'::jsonb),
        'companyPins', '[]'::jsonb
      ) AS context
      FROM customers c
      LEFT JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
      LEFT JOIN organizations o ON o.organization_seq=m.organization_seq AND o.deleted_at IS NULL
      LEFT JOIN departments d ON d.department_seq=m.department_seq AND d.organization_seq=m.organization_seq AND d.deleted_at IS NULL
      WHERE c.phone_number=$1 AND (c.deleted_at IS NULL OR c.status='WITHDRAWN')
      ORDER BY c.deleted_at NULLS FIRST,c.customer_seq DESC LIMIT 1`,
      [phoneNumber],
    );
    return (
      result.rows[0]?.context ?? {
        lookupStatus: 'UNREGISTERED',
        customer: null,
        membership: null,
        organization: null,
        department: null,
        availablePaymentMethods: [],
        availableUsageTypes: [],
        personalPins: [],
        companyPins: [],
      }
    );
  }

  async insertForOrder(
    client: PoolClient,
    input: Pick<CreateCustomerDto, 'name' | 'phoneNumber'>,
  ): Promise<Customer | undefined> {
    if (await this.findByPhoneForOrder(client, input.phoneNumber)) return undefined;
    return (
      await client.query<Customer>(
        `INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE')
       ON CONFLICT(phone_number) WHERE deleted_at IS NULL DO NOTHING RETURNING ${columns}`,
        [input.name, input.phoneNumber],
      )
    ).rows[0];
  }

  async findByPhoneForOrder(client: PoolClient, phone: string): Promise<Customer | undefined> {
    return (
      await client.query<Customer>(
        `SELECT ${columns} FROM customers WHERE phone_number=$1
         AND (deleted_at IS NULL OR status='WITHDRAWN')
         ORDER BY deleted_at NULLS FIRST,customer_seq DESC LIMIT 1 FOR SHARE`,
        [phone],
      )
    ).rows[0];
  }

  async list(query: ListCustomersQueryDto): Promise<PageRows<CustomerListItemDto>> {
    const nameSearch =
      [...(query.q ?? '')].length >= 3
        ? "lower(c.name) LIKE '%' || replace(replace(replace(lower($1),'!','!!'),'%','!%'),'_','!_') || '%' ESCAPE '!'"
        : 'strpos(lower(c.name), lower($1)) > 0';
    const result = await readPage<CustomerListItemDto>(
      this.database.pool,
      `SELECT c.customer_seq AS "customerSeq",c.name,c.phone_number AS "phoneNumber",c.status,
         c.monthly_billing_enabled AS "monthlyBillingEnabled",c.address_data AS address
       FROM customers c
       WHERE c.deleted_at IS NULL AND ($1::text IS NULL OR ${nameSearch})
         AND ($2::text IS NULL OR strpos(c.phone_number, $2) > 0)
         AND ($3::text IS NULL OR c.status = $3)`,
      [query.q || null, query.phoneNumber ?? null, query.status ?? null],
      query,
      '"customerSeq" DESC',
      `page.*,(SELECT ${availablePaymentMethods} FROM customers c
        LEFT JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
        LEFT JOIN organizations o ON o.organization_seq=m.organization_seq AND o.deleted_at IS NULL
        LEFT JOIN departments d ON d.department_seq=m.department_seq AND d.organization_seq=m.organization_seq AND d.deleted_at IS NULL
        WHERE c.customer_seq=page."customerSeq") AS "availablePaymentMethods"`,
    );
    return result;
  }

  async find(id: number, client?: PoolClient): Promise<Customer | undefined> {
    const result = await (client ?? this.database.pool).query<Customer>(
      `SELECT ${columns} FROM customers WHERE customer_seq = $1 AND deleted_at IS NULL${client ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return result.rows[0];
  }

  async update(id: number, changes: UpdateCustomerDto, client: PoolClient): Promise<void> {
    await client.query(
      'UPDATE customers SET name = COALESCE($2, name), status = COALESCE($3, status),monthly_billing_enabled=COALESCE($4,monthly_billing_enabled),address_data=CASE WHEN $5::boolean THEN $6::jsonb ELSE address_data END WHERE customer_seq = $1',
      [
        id,
        changes.name ?? null,
        changes.status ?? null,
        changes.monthlyBillingEnabled ?? null,
        changes.address !== undefined,
        changes.address ?? null,
      ],
    );
  }

  async insert(client: PoolClient, input: CreateCustomerDto): Promise<number> {
    const result = await client.query<{ customerSeq: number }>(
      `INSERT INTO customers (name, phone_number, status,monthly_billing_enabled,address_data) VALUES ($1, $2, 'ACTIVE',$3,$4)
       RETURNING customer_seq AS "customerSeq"`,
      [input.name, input.phoneNumber, input.monthlyBillingEnabled ?? false, input.address ?? null],
    );
    return result.rows[0].customerSeq;
  }
}
