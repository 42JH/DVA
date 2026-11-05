import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { PageRows, readPage } from '../common/pagination-query';
import { DatabaseService } from '../database/database.service';
import { Customer, EmployeeCustomerIdentity } from './customers.types';
import { CreateCustomerDto, ListCustomersQueryDto } from './dto/customer-request.dto';

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

  async insert(client: PoolClient, input: CreateCustomerDto): Promise<number> {
    const result = await client.query<{ customerSeq: number }>(
      `INSERT INTO customers (name, phone_number, status,monthly_billing_enabled,address_data) VALUES ($1, $2, 'ACTIVE',$3,$4)
       RETURNING customer_seq AS "customerSeq"`,
      [input.name, input.phoneNumber, input.monthlyBillingEnabled ?? false, input.address ?? null],
    );
    return result.rows[0].customerSeq;
  }
}
