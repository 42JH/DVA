import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { Organization } from './organizations.types';

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(query: ListOrganizationsQueryDto): Promise<Organization[]> {
    const result = await this.database.pool.query<Organization>(
      `SELECT organization_seq AS "organizationSeq", name, status FROM organizations
       WHERE ($1::text IS NULL OR strpos(lower(name), lower($1)) > 0)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY organization_seq DESC LIMIT $3 OFFSET $4`,
      [query.q || null, query.status ?? null, query.limit + 1, query.offset],
    );
    return result.rows;
  }

  async find(id: number): Promise<Organization | undefined> {
    const result = await this.database.pool.query<Organization>(
      `SELECT organization_seq AS "organizationSeq", name, status
       FROM organizations WHERE organization_seq = $1`,
      [id],
    );
    return result.rows[0];
  }

  async update(id: number, changes: UpdateOrganizationDto): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE organizations SET name = COALESCE($2, name), status = COALESCE($3, status)
       WHERE organization_seq = $1 RETURNING organization_seq`,
      [id, changes.name ?? null, changes.status ?? null],
    );
    return result.rowCount === 1;
  }

  async lockCreation(client: PoolClient, adminId: number, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`organizations.create:${adminId}:${key}`).digest();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired',
      [hash.readInt32BE(0), hash.readInt32BE(4)],
    );
    return result.rows[0].acquired;
  }

  async findCreation(client: PoolClient, adminId: number, key: string) {
    const result = await client.query<{ requestHash: string; organizationSeq: number }>(
      `SELECT request_hash AS "requestHash", organization_seq AS "organizationSeq"
       FROM api_idempotency.organization_creations WHERE admin_user_seq = $1 AND idempotency_key = $2::uuid`,
      [adminId, key],
    );
    return result.rows[0];
  }

  async insert(client: PoolClient, name: string): Promise<number> {
    const result = await client.query<{ organizationSeq: number }>(
      `INSERT INTO organizations (name, status) VALUES ($1, 'ACTIVE')
       RETURNING organization_seq AS "organizationSeq"`,
      [name],
    );
    return result.rows[0].organizationSeq;
  }

  async rememberCreation(
    client: PoolClient,
    adminId: number,
    key: string,
    hash: string,
    id: number,
  ) {
    await client.query(
      `INSERT INTO api_idempotency.organization_creations
       (admin_user_seq, idempotency_key, request_hash, organization_seq) VALUES ($1, $2::uuid, $3, $4)`,
      [adminId, key, hash, id],
    );
  }
}
