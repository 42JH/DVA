import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
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
}
