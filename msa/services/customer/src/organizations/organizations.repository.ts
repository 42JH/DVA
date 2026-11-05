import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationSummaryDto } from './dto/organization-response.dto';
import { CompanyDirectoryEntryDto, CompanyDirectoryQueryDto } from './dto/company-directory.dto';

const summaryColumns = `o.organization_seq AS "organizationSeq",o.name,o.status,
  o.monthly_billing_enabled AS "monthlyBillingEnabled",o.created_at AS "createdAt",
  (SELECT count(*)::integer FROM memberships m
   WHERE m.organization_seq=o.organization_seq AND m.status='ACTIVE' AND m.deleted_at IS NULL) AS "memberCount"`;

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async searchDirectory(
    query: CompanyDirectoryQueryDto,
  ): Promise<PageRows<CompanyDirectoryEntryDto>> {
    // 사원 기본 주소를 복제하지 않고 현재 고객 정보와 활성 소속을 같은 스냅샷에서 읽는다.
    return await readPage<CompanyDirectoryEntryDto>(
      this.database.pool,
      `SELECT o.organization_seq AS "organizationSeq",o.name AS "organizationName",
        m.membership_seq AS "membershipSeq",c.customer_seq AS "customerSeq",
        d.department_seq AS "departmentSeq",d.name AS "departmentName",
        c.address_data || jsonb_build_object('name',c.name,'phoneNumber',c.phone_number) AS "addressData"
       FROM organizations o JOIN memberships m ON m.organization_seq=o.organization_seq
       JOIN customers c ON c.customer_seq=m.customer_seq
       LEFT JOIN departments d ON d.department_seq=m.department_seq AND d.organization_seq=o.organization_seq AND d.deleted_at IS NULL
       WHERE o.status='ACTIVE' AND m.status='ACTIVE' AND c.status='ACTIVE'
         AND o.deleted_at IS NULL AND m.deleted_at IS NULL AND c.deleted_at IS NULL
         AND c.address_data IS NOT NULL AND NOT EXISTS(
         SELECT 1 FROM unnest($1::text[]) AS terms(term)
         WHERE strpos(lower(normalize(concat_ws(' ',o.name,d.name,c.name,c.phone_number,
           c.address_data->>'roadAddress',c.address_data->>'jibunAddress',c.address_data->>'detailAddress',
           c.address_data->>'dongName',c.address_data->>'postalCode'),NFC)),lower(normalize(term,NFC)))=0)`,
      [query.q.split(' ')],
      query,
      'lower(normalize("organizationName",NFC)),"organizationSeq","customerSeq"',
    );
  }

  async list(query: ListOrganizationsQueryDto): Promise<PageRows<OrganizationSummaryDto>> {
    const result = await readPage<OrganizationSummaryDto>(
      this.database.pool,
      `SELECT ${summaryColumns} FROM organizations o
       WHERE o.deleted_at IS NULL AND ($1::text IS NULL OR strpos(lower(o.name), lower($1)) > 0)
         AND ($2::text IS NULL OR o.status = $2)`,
      [query.q || null, query.status ?? null],
      query,
      '"organizationSeq" DESC',
    );
    return result;
  }

  async find(id: number): Promise<OrganizationSummaryDto | undefined> {
    const result = await this.database.pool.query<OrganizationSummaryDto>(
      `SELECT ${summaryColumns} FROM organizations o WHERE o.organization_seq = $1 AND o.deleted_at IS NULL`,
      [id],
    );
    return result.rows[0];
  }

  async update(id: number, changes: UpdateOrganizationDto, client: PoolClient): Promise<boolean> {
    const result = await client.query(
      `UPDATE organizations SET name = COALESCE($2, name), status = COALESCE($3, status),monthly_billing_enabled=COALESCE($4,monthly_billing_enabled)
       WHERE organization_seq = $1 AND deleted_at IS NULL RETURNING organization_seq`,
      [id, changes.name ?? null, changes.status ?? null, changes.monthlyBillingEnabled ?? null],
    );
    return result.rowCount === 1;
  }

  async insert(client: PoolClient, name: string, monthlyBillingEnabled = false): Promise<number> {
    const result = await client.query<{ organizationSeq: number }>(
      `INSERT INTO organizations (name, status,monthly_billing_enabled) VALUES ($1, 'ACTIVE',$2)
       RETURNING organization_seq AS "organizationSeq"`,
      [name, monthlyBillingEnabled],
    );
    return result.rows[0].organizationSeq;
  }
}
