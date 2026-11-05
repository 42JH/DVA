import { readPage, type PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ListCustomersQueryDto } from './dto/customer-request.dto';
import { type Customer } from './customers.types';

const columns =
  'customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status,monthly_billing_enabled AS "monthlyBillingEnabled",address_data AS address';

@Injectable()
export class CustomersRepository {
  constructor(private readonly database: DatabaseService) {}
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
}
