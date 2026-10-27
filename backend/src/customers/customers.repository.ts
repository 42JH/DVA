import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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

  async lockCreation(client: PoolClient, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`customers.create:${key}`).digest();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired',
      [hash.readInt32BE(0), hash.readInt32BE(4)],
    );
    return result.rows[0].acquired;
  }

  async findCreation(client: PoolClient, key: string) {
    const result = await client.query<{ requestHash: string; customerSeq: number }>(
      `SELECT request_hash AS "requestHash", customer_seq AS "customerSeq"
       FROM api_idempotency.customer_creations WHERE idempotency_key = $1::uuid`,
      [key],
    );
    return result.rows[0];
  }

  async insert(client: PoolClient, input: CreateCustomerDto): Promise<number> {
    const result = await client.query<{ customerSeq: number }>(
      `INSERT INTO customers (name, phone_number, status) VALUES ($1, $2, 'ACTIVE')
       RETURNING customer_seq AS "customerSeq"`,
      [input.name, input.phoneNumber],
    );
    return result.rows[0].customerSeq;
  }

  async rememberCreation(client: PoolClient, key: string, hash: string, id: number): Promise<void> {
    await client.query(
      `INSERT INTO api_idempotency.customer_creations (idempotency_key, request_hash, customer_seq)
       VALUES ($1::uuid, $2, $3)`,
      [key, hash, id],
    );
  }
}
