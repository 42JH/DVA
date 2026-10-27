import { Injectable } from '@nestjs/common';

import { createHash } from 'node:crypto';

import { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

import { Customer } from '../customers/customers.types';

import { CreateMemberDto, ListMembersQueryDto } from './dto/member-request.dto';

import { MemberViewDto } from './dto/member-response.dto';

@Injectable()
export class MembersRepository {
  constructor(private readonly database: DatabaseService) {}

  async company(id: number, client?: PoolClient) {
    const result = await (client ?? this.database.pool).query<{
      organizationSeq: number;
      status: string;
    }>(
      `SELECT organization_seq AS "organizationSeq", status FROM organizations WHERE organization_seq=$1${client ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return result.rows[0];
  }

  async list(companyId: number, query: ListMembersQueryDto): Promise<MemberViewDto[]> {
    const result = await this.database.pool.query<MemberViewDto>(
      `SELECT jsonb_build_object('membershipSeq',m.membership_seq,'customerSeq',m.customer_seq,
        'organizationSeq',m.organization_seq,'employeeNo',m.employee_no,'role',m.role,'status',m.status) AS membership,
        jsonb_build_object('customerSeq',c.customer_seq,'name',c.name,'phoneNumber',c.phone_number,'status',c.status) AS customer
       FROM memberships m JOIN customers c ON c.customer_seq=m.customer_seq
       WHERE m.organization_seq=$1 AND ($2::text IS NULL OR m.status=$2)
       ORDER BY m.membership_seq DESC LIMIT $3 OFFSET $4`,
      [companyId, query.status ?? null, query.limit + 1, query.offset],
    );
    return result.rows;
  }

  async customer(id: number, client: PoolClient): Promise<Customer | undefined> {
    const result = await client.query<Customer>(
      'SELECT customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status FROM customers WHERE customer_seq=$1 FOR UPDATE',
      [id],
    );
    return result.rows[0];
  }

  async create(companyId: number, input: CreateMemberDto, client: PoolClient): Promise<number> {
    const result = await client.query<{ id: number }>(
      `INSERT INTO memberships (organization_seq,customer_seq,employee_no,role,status)
       VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING membership_seq AS id`,
      [companyId, input.customerSeq, input.employeeNo, input.role],
    );
    return result.rows[0].id;
  }

  async lockKey(client: PoolClient, adminId: number, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`members.write:${adminId}:${key}`).digest();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS acquired',
      [hash.readInt32BE(0), hash.readInt32BE(4)],
    );
    return result.rows[0].acquired;
  }

  async lockWrites(client: PoolClient): Promise<boolean> {
    // MVP: serialize all membership mutations, including cross-company CSV phone changes.
    // Try-lock avoids waiting on another upload and returns a retryable 409 instead.
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(20261027,37) AS acquired',
    );
    return result.rows[0].acquired;
  }

  async receipt(adminId: number, key: string, client: PoolClient) {
    const result = await client.query<{ requestHash: string }>(
      'SELECT request_hash AS "requestHash" FROM api_idempotency.membership_writes WHERE admin_user_seq=$1 AND idempotency_key=$2::uuid',
      [adminId, key],
    );
    return result.rows[0];
  }

  async remember(
    adminId: number,
    key: string,
    companyId: number,
    operation: string,
    hash: string,
    client: PoolClient,
  ): Promise<void> {
    await client.query(
      `INSERT INTO api_idempotency.membership_writes
      (admin_user_seq,idempotency_key,organization_seq,operation,request_hash) VALUES ($1,$2::uuid,$3,$4,$5)`,
      [adminId, key, companyId, operation, hash],
    );
  }
}
