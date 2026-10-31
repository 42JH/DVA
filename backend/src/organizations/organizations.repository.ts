import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { Organization } from './organizations.types';
import { CompanyDirectoryEntryDto, CompanyDirectoryQueryDto } from './dto/company-directory.dto';

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly database: DatabaseService) {}

  async searchDirectory(
    query: CompanyDirectoryQueryDto,
  ): Promise<PageRows<CompanyDirectoryEntryDto>> {
    // 기업 공유 PIN 전체가 공식 공개 배송지라는 40번 합의를 적용한다.
    // 구성원·개인 PIN과 조인하지 않고 기업 상태와 PIN을 한 SQL 스냅샷에서 읽는다.
    return await readPage<CompanyDirectoryEntryDto>(
      this.database.pool,
      `SELECT o.organization_seq AS "organizationSeq",o.name AS "organizationName",
        p.company_pin_seq AS "companyPinSeq",p.label,p.department_name AS "departmentName",p.department_seq AS "departmentSeq",
        p.address_data AS "addressData",p.version
       FROM organizations o JOIN company_pins p ON p.organization_seq=o.organization_seq
       WHERE o.status='ACTIVE' AND NOT EXISTS(
         SELECT 1 FROM unnest($1::text[]) AS terms(term)
         WHERE strpos(lower(normalize(concat_ws(' ',o.name,p.search_text,
           p.address_data->>'dongName',p.address_data->>'postalCode'),NFC)),lower(normalize(term,NFC)))=0)`,
      [query.q.split(' ')],
      query,
      'lower(normalize("organizationName",NFC)),"organizationSeq","companyPinSeq"',
    );
  }

  async list(query: ListOrganizationsQueryDto): Promise<PageRows<Organization>> {
    const result = await readPage<Organization>(
      this.database.pool,
      `SELECT organization_seq AS "organizationSeq", name, status,monthly_billing_enabled AS "monthlyBillingEnabled" FROM organizations
       WHERE ($1::text IS NULL OR strpos(lower(name), lower($1)) > 0)
         AND ($2::text IS NULL OR status = $2)`,
      [query.q || null, query.status ?? null],
      query,
      '"organizationSeq" DESC',
    );
    return result;
  }

  async find(id: number): Promise<Organization | undefined> {
    const result = await this.database.pool.query<Organization>(
      `SELECT organization_seq AS "organizationSeq", name, status,monthly_billing_enabled AS "monthlyBillingEnabled"
       FROM organizations WHERE organization_seq = $1`,
      [id],
    );
    return result.rows[0];
  }

  async update(id: number, changes: UpdateOrganizationDto, client: PoolClient): Promise<boolean> {
    const result = await client.query(
      `UPDATE organizations SET name = COALESCE($2, name), status = COALESCE($3, status),monthly_billing_enabled=COALESCE($4,monthly_billing_enabled)
       WHERE organization_seq = $1 RETURNING organization_seq`,
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
