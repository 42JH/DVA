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

const columns =
  'customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status,monthly_billing_enabled AS "monthlyBillingEnabled",address_data AS address';

@Injectable()
export class CustomersRepository {
  constructor(private readonly database: DatabaseService) {}

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
          'employeeNo',m.employee_no,'role',m.role,'status',m.status,'departmentSeq',m.department_seq) END,
        'organization', CASE WHEN c.status='ACTIVE' AND o.organization_seq IS NOT NULL THEN jsonb_build_object(
          'organizationSeq',o.organization_seq,'name',o.name,'status',o.status,'monthlyBillingEnabled',o.monthly_billing_enabled) END,
        'department',CASE WHEN c.status='ACTIVE' AND d.department_seq IS NOT NULL THEN jsonb_build_object(
          'departmentSeq',d.department_seq,'organizationSeq',d.organization_seq,'name',d.name,'groupBillingEnabled',d.group_billing_enabled) END,
        'availablePaymentMethods',CASE WHEN c.status<>'ACTIVE' THEN '[]'::jsonb ELSE
          '["billing"]'::jsonb || CASE WHEN
            (m.membership_seq IS NULL AND c.monthly_billing_enabled)
            OR (m.status='ACTIVE' AND o.status='ACTIVE' AND o.monthly_billing_enabled)
            THEN '["credit"]'::jsonb ELSE '[]'::jsonb END
          || CASE WHEN m.status='ACTIVE' AND o.status='ACTIVE' AND d.group_billing_enabled
            THEN '["groupBilling"]'::jsonb ELSE '[]'::jsonb END END,
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
      WHERE c.phone_number=$1 AND c.deleted_at IS NULL`,
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
    input: CreateCustomerDto,
  ): Promise<Customer | undefined> {
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
        `SELECT ${columns} FROM customers WHERE phone_number=$1 AND deleted_at IS NULL FOR SHARE`,
        [phone],
      )
    ).rows[0];
  }

  async list(query: ListCustomersQueryDto): Promise<PageRows<Customer>> {
    const result = await readPage<Customer>(
      this.database.pool,
      `SELECT ${columns} FROM customers
       WHERE deleted_at IS NULL AND ($1::text IS NULL OR strpos(lower(name), lower($1)) > 0)
         AND ($2::text IS NULL OR phone_number = $2)
         AND ($3::text IS NULL OR status = $3)`,
      [query.q || null, query.phoneNumber ?? null, query.status ?? null],
      query,
      '"customerSeq" DESC',
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
