import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer-request.dto';
import { Customer } from './customers.types';

const columns = 'customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status';

@Injectable()
export class CustomersRepository {
  constructor(private readonly database: DatabaseService) {}

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
