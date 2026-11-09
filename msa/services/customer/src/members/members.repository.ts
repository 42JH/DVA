import { MemberSearchEntryDto, SearchMembersQueryDto } from './dto/search-members.dto';
import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Customer } from '../customers/customers.types';
import {
  CreateMemberDto,
  InlineMemberDto,
  ListMembersQueryDto,
  UpdateMemberDto,
} from './dto/member-request.dto';
import { ImportedMembership, MemberCandidate, Membership } from './members.types';
import { MemberViewDto } from './dto/member-response.dto';

const memberColumns =
  'membership_seq AS "membershipSeq", customer_seq AS "customerSeq", organization_seq AS "organizationSeq",department_seq AS "departmentSeq", employee_no AS "employeeNo", role, status';

@Injectable()
export class MembersRepository {
  constructor(private readonly database: DatabaseService) {}

  async search(query: SearchMembersQueryDto): Promise<PageRows<MemberSearchEntryDto>> {
    return readPage<MemberSearchEntryDto>(
      this.database.pool,
      `SELECT o.organization_seq AS "organizationSeq",o.name AS "organizationName",
        o.status AS "organizationStatus",m.membership_seq AS "membershipSeq",
        m.status AS "membershipStatus",m.employee_no AS "employeeNo",
        d.name AS "departmentName",c.name,c.phone_number AS "phoneNumber"
       FROM memberships m JOIN organizations o ON o.organization_seq=m.organization_seq
       JOIN customers c ON c.customer_seq=m.customer_seq
       LEFT JOIN departments d ON d.department_seq=m.department_seq
         AND d.organization_seq=o.organization_seq AND d.deleted_at IS NULL
       WHERE o.deleted_at IS NULL AND m.deleted_at IS NULL AND c.deleted_at IS NULL
         AND c.status='ACTIVE' AND ($2::boolean OR (o.status='ACTIVE' AND m.status='ACTIVE'))
         AND NOT EXISTS(SELECT 1 FROM unnest($1::text[]) AS terms(term)
           WHERE strpos(lower(normalize(concat_ws(' ',c.name,m.employee_no,d.name),NFC)),lower(normalize(term,NFC)))=0
             AND NOT (term ~ '^[0-9-]+$' AND replace(term,'-','')<>''
               AND strpos(regexp_replace(c.phone_number,'[^0-9]','','g'),replace(term,'-',''))>0))`,
      [query.q.split(' '), query.includeInactive],
      query,
      'lower(normalize("organizationName",NFC)),"organizationSeq","membershipSeq"',
    );
  }

  async company(id: number, client?: PoolClient) {
    const result = await (client ?? this.database.pool).query<{
      organizationSeq: number;
      status: string;
    }>(
      `SELECT organization_seq AS "organizationSeq", status FROM organizations WHERE organization_seq=$1 AND deleted_at IS NULL${client ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return result.rows[0];
  }

  async list(companyId: number, query: ListMembersQueryDto): Promise<PageRows<MemberViewDto>> {
    const result = await readPage<MemberViewDto>(
      this.database.pool,
      `SELECT jsonb_build_object('membershipSeq',m.membership_seq,'customerSeq',m.customer_seq,
        'organizationSeq',m.organization_seq,'departmentSeq',m.department_seq,'employeeNo',m.employee_no,'role',m.role,'status',m.status) AS membership,
        jsonb_build_object('customerSeq',c.customer_seq,'name',c.name,'phoneNumber',c.phone_number,'status',c.status,'monthlyBillingEnabled',c.monthly_billing_enabled,'address',c.address_data) AS customer
       FROM memberships m JOIN customers c ON c.customer_seq=m.customer_seq
       WHERE m.organization_seq=$1 AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND ($2::text IS NULL OR m.status=$2)`,
      [companyId, query.status ?? null],
      query,
      "(membership->>'membershipSeq')::integer DESC",
    );
    return result;
  }

  async member(id: number, client?: PoolClient): Promise<Membership | undefined> {
    const result = await (client ?? this.database.pool).query<Membership>(
      `SELECT ${memberColumns} FROM memberships WHERE membership_seq=$1 AND deleted_at IS NULL`,
      [id],
    );
    return result.rows[0];
  }

  async customer(id: number, client: PoolClient): Promise<Customer | undefined> {
    const result = await client.query<Customer>(
      'SELECT customer_seq AS "customerSeq", name, phone_number AS "phoneNumber", status FROM customers WHERE customer_seq=$1 AND deleted_at IS NULL FOR UPDATE',
      [id],
    );
    return result.rows[0];
  }

  async create(companyId: number, input: CreateMemberDto, client: PoolClient): Promise<number> {
    const result = await client.query<{ id: number }>(
      `INSERT INTO memberships (organization_seq,customer_seq,employee_no,role,status,department_seq)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5) RETURNING membership_seq AS id`,
      [companyId, input.customerSeq, input.employeeNo, input.role, input.departmentSeq],
    );
    return result.rows[0].id;
  }

  async update(id: number, changes: UpdateMemberDto, client: PoolClient): Promise<void> {
    await client.query(
      'UPDATE memberships SET role=COALESCE($2,role),status=COALESCE($3,status),department_seq=CASE WHEN $5::boolean THEN $4::int ELSE department_seq END WHERE membership_seq=$1',
      [
        id,
        changes.role ?? null,
        changes.status ?? null,
        changes.departmentSeq ?? null,
        changes.departmentSeq !== undefined,
      ],
    );
  }

  async remove(id: number, client: PoolClient): Promise<void> {
    await client.query(
      'UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=$1 AND deleted_at IS NULL',
      [id],
    );
  }

  async department(companyId: number, departmentId: number, client: PoolClient): Promise<boolean> {
    return (
      (
        await client.query(
          'SELECT 1 FROM departments WHERE organization_seq=$1 AND department_seq=$2 AND deleted_at IS NULL FOR SHARE',
          [companyId, departmentId],
        )
      ).rowCount === 1
    );
  }

  async lockDepartments(companyId: number, ids: number[], client: PoolClient): Promise<boolean> {
    if (!ids.length) return true;
    const result = await client.query(
      'SELECT department_seq FROM departments WHERE organization_seq=$1 AND department_seq=ANY($2::int[]) AND deleted_at IS NULL ORDER BY department_seq FOR SHARE',
      [companyId, ids],
    );
    return result.rowCount === ids.length;
  }

  async lockWrites(client: PoolClient): Promise<void> {
    // 고객을 잠그기 전에 소속 변경을 직렬화해 조회한 소속의 고객 연결을 유지한다.
    await client.query('SELECT pg_advisory_xact_lock(20261027,37)');
  }

  async candidates(
    companyId: number,
    rows: InlineMemberDto[],
    client: PoolClient,
  ): Promise<MemberCandidate[]> {
    const result = await client.query<MemberCandidate>(
      `SELECT c.customer_seq AS "customerSeq",c.name,c.phone_number AS "phoneNumber",c.status AS "customerStatus",
       m.membership_seq AS "membershipSeq",m.organization_seq AS "organizationSeq",m.employee_no AS "employeeNo"
       FROM customers c LEFT JOIN memberships m ON m.customer_seq=c.customer_seq AND m.deleted_at IS NULL
       WHERE c.deleted_at IS NULL AND (c.phone_number=ANY($1::text[]) OR (m.organization_seq=$2 AND m.employee_no=ANY($3::text[])))`,
      [rows.map((row) => row.phoneNumber), companyId, rows.map((row) => row.employeeNo)],
    );
    return result.rows;
  }

  async lockCustomers(ids: number[], client: PoolClient): Promise<void> {
    await client.query(
      'SELECT customer_seq FROM customers WHERE customer_seq=ANY($1::int[]) ORDER BY customer_seq FOR UPDATE',
      [ids],
    );
  }

  async importRows(
    companyId: number,
    rows: ImportedMembership[],
    client: PoolClient,
  ): Promise<void> {
    const added = rows.filter((row) => row.membershipSeq === null);
    if (added.length)
      await client.query(
        `INSERT INTO memberships(organization_seq,customer_seq,employee_no,role,status,department_seq)
         SELECT $1,r."customerSeq",r."employeeNo",COALESCE(r.role,'MEMBER'),'ACTIVE',r."departmentSeq"
         FROM jsonb_to_recordset($2::jsonb) AS r("customerSeq" int,"employeeNo" text,"departmentSeq" int,role text)`,
        [companyId, JSON.stringify(added)],
      );
    const updated = rows.filter((row) => row.membershipSeq !== null);
    if (updated.length)
      await client.query(
        `UPDATE memberships m SET department_seq=CASE WHEN r."changeDepartment" THEN r."departmentSeq" ELSE m.department_seq END,
         role=COALESCE(r.role,m.role)
         FROM jsonb_to_recordset($1::jsonb) AS r("membershipSeq" int,"departmentSeq" int,"changeDepartment" boolean,role text)
         WHERE m.membership_seq=r."membershipSeq"`,
        [
          JSON.stringify(
            updated.map((row) => ({ ...row, changeDepartment: row.departmentSeq !== undefined })),
          ),
        ],
      );
  }
}
