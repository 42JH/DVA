import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
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

  async update(id: number, changes: UpdateOrganizationDto, client: PoolClient): Promise<boolean> {
    const result = await client.query(
      `UPDATE organizations SET name = COALESCE($2, name), status = COALESCE($3, status)
       WHERE organization_seq = $1 RETURNING organization_seq`,
      [id, changes.name ?? null, changes.status ?? null],
    );
    return result.rowCount === 1;
  }

  async insert(client: PoolClient, name: string): Promise<number> {
    const result = await client.query<{ organizationSeq: number }>(
      `INSERT INTO organizations (name, status) VALUES ($1, 'ACTIVE')
       RETURNING organization_seq AS "organizationSeq"`,
      [name],
    );
    return result.rows[0].organizationSeq;
  }
}
