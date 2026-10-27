import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer-request.dto';
import { Customer } from './customers.types';
import { CallerContextDto } from './dto/caller-context.dto';

const columns = 'customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status';

@Injectable()
export class CustomersRepository {
  constructor(private readonly database: DatabaseService) {}

  async context(phoneNumber: string): Promise<CallerContextDto> {
    // 한 SQL 문장의 스냅샷으로 고객·소속 상태와 허용 주소록을 함께 읽는다.
    const result = await this.database.pool.query<{ context: CallerContextDto }>(
      `SELECT jsonb_build_object(
        'lookupStatus', CASE WHEN c.status='ACTIVE' THEN 'REGISTERED' ELSE 'WITHDRAWN' END,
        'customer', CASE WHEN c.status='ACTIVE' THEN jsonb_build_object(
          'customerSeq',c.customer_seq,'name',c.name,'phoneNumber',c.phone_number,'status',c.status) END,
        'membership', CASE WHEN c.status='ACTIVE' AND m.membership_seq IS NOT NULL THEN jsonb_build_object(
          'membershipSeq',m.membership_seq,'customerSeq',m.customer_seq,'organizationSeq',m.organization_seq,
          'employeeNo',m.employee_no,'role',m.role,'status',m.status) END,
        'organization', CASE WHEN c.status='ACTIVE' AND o.organization_seq IS NOT NULL THEN jsonb_build_object(
          'organizationSeq',o.organization_seq,'name',o.name,'status',o.status) END,
        'availableUsageTypes', CASE
          WHEN c.status<>'ACTIVE' THEN '[]'::jsonb
          WHEN m.status='ACTIVE' AND o.status='ACTIVE' THEN '["PERSONAL","COMPANY"]'::jsonb
          ELSE '["PERSONAL"]'::jsonb END,
        'personalPins', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'personalPinSeq',p.personal_pin_seq,'label',p.label,'addressData',p.address_data,'version',p.version)
          ORDER BY p.personal_pin_seq)
          FROM personal_pins p WHERE p.customer_seq=c.customer_seq AND c.status='ACTIVE'), '[]'::jsonb),
        'companyPins', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'companyPinSeq',p.company_pin_seq,'label',p.label,'departmentName',p.department_name,
          'addressData',p.address_data,'version',p.version) ORDER BY p.company_pin_seq)
          FROM company_pins p WHERE p.organization_seq=o.organization_seq
            AND c.status='ACTIVE' AND m.status='ACTIVE' AND o.status='ACTIVE'), '[]'::jsonb)
      ) AS context
      FROM customers c
      LEFT JOIN memberships m ON m.customer_seq=c.customer_seq
      LEFT JOIN organizations o ON o.organization_seq=m.organization_seq
      WHERE c.phone_number=$1`,
      [phoneNumber],
    );
    return (
      result.rows[0]?.context ?? {
        lookupStatus: 'UNREGISTERED',
        customer: null,
        membership: null,
        organization: null,
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
       ON CONFLICT(phone_number) DO NOTHING RETURNING ${columns}`,
        [input.name, input.phoneNumber],
      )
    ).rows[0];
  }

  async findByPhoneForOrder(client: PoolClient, phone: string): Promise<Customer | undefined> {
    return (
      await client.query<Customer>(
        `SELECT ${columns} FROM customers WHERE phone_number=$1 FOR SHARE`,
        [phone],
      )
    ).rows[0];
  }

  async list(query: ListCustomersQueryDto): Promise<Customer[]> {
    const result = await this.database.pool.query<Customer>(
      `SELECT ${columns} FROM customers
       WHERE ($1::text IS NULL OR strpos(lower(name), lower($1)) > 0)
         AND ($2::text IS NULL OR phone_number = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY customer_seq DESC LIMIT $4 OFFSET $5`,
      [
        query.q || null,
        query.phoneNumber ?? null,
        query.status ?? null,
        query.limit + 1,
        query.offset,
      ],
    );
    return result.rows;
  }

  async find(id: number, client?: PoolClient): Promise<Customer | undefined> {
    const result = await (client ?? this.database.pool).query<Customer>(
      `SELECT ${columns} FROM customers WHERE customer_seq = $1${client ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return result.rows[0];
  }

  async update(id: number, changes: UpdateCustomerDto, client: PoolClient): Promise<void> {
    await client.query(
      'UPDATE customers SET name = COALESCE($2, name), status = COALESCE($3, status) WHERE customer_seq = $1',
      [id, changes.name ?? null, changes.status ?? null],
    );
  }

  async insert(client: PoolClient, input: CreateCustomerDto): Promise<number> {
    const result = await client.query<{ customerSeq: number }>(
      `INSERT INTO customers (name, phone_number, status) VALUES ($1, $2, 'ACTIVE')
       RETURNING customer_seq AS "customerSeq"`,
      [input.name, input.phoneNumber],
    );
    return result.rows[0].customerSeq;
  }
}
