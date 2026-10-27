import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

interface CustomerRow {
  id: number;
  status: 'ACTIVE' | 'WITHDRAWN';
}

@Injectable()
export class CustomersRepository {
  async findById(client: PoolClient, id: number): Promise<CustomerRow | undefined> {
    return (
      await client.query<CustomerRow>(
        'SELECT customer_seq AS id,status FROM customers WHERE customer_seq=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
  }

  async findByPhone(client: PoolClient, phoneNumber: string): Promise<CustomerRow | undefined> {
    return (
      await client.query<CustomerRow>(
        'SELECT customer_seq AS id,status FROM customers WHERE phone_number=$1 FOR SHARE',
        [phoneNumber],
      )
    ).rows[0];
  }

  async insertIfNew(
    client: PoolClient,
    input: { name: string; phoneNumber: string },
  ): Promise<CustomerRow | undefined> {
    return (
      await client.query<CustomerRow>(
        `INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE')
         ON CONFLICT (phone_number) DO NOTHING RETURNING customer_seq AS id,status`,
        [input.name, input.phoneNumber],
      )
    ).rows[0];
  }
}
