import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Customer } from '../customers/customers.types';
import { CreateMemberDto, ListMembersQueryDto, UpdateMemberDto } from './dto/member-request.dto';
import { CsvMemberRow, MemberCandidate, Membership } from './members.types';
import { MemberViewDto } from './dto/member-response.dto';

const memberColumns =
  'membership_seq AS "membershipSeq", customer_seq AS "customerSeq", organization_seq AS "organizationSeq",department_seq AS "departmentSeq", employee_no AS "employeeNo", role, status';

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

  async list(companyId: number, query: ListMembersQueryDto): Promise<PageRows<MemberViewDto>> {
    const result = await readPage<MemberViewDto>(
      this.database.pool,
      `SELECT jsonb_build_object('membershipSeq',m.membership_seq,'customerSeq',m.customer_seq,
        'organizationSeq',m.organization_seq,'departmentSeq',m.department_seq,'employeeNo',m.employee_no,'role',m.role,'status',m.status) AS membership,
        jsonb_build_object('customerSeq',c.customer_seq,'name',c.name,'phoneNumber',c.phone_number,'status',c.status,'monthlyBillingEnabled',c.monthly_billing_enabled) AS customer
       FROM memberships m JOIN customers c ON c.customer_seq=m.customer_seq
       WHERE m.organization_seq=$1 AND ($2::text IS NULL OR m.status=$2)`,
      [companyId, query.status ?? null],
      query,
      "(membership->>'membershipSeq')::integer DESC",
    );
    return result;
  }

  async member(id: number, client?: PoolClient): Promise<Membership | undefined> {
    const result = await (client ?? this.database.pool).query<Membership>(
      `SELECT ${memberColumns} FROM memberships WHERE membership_seq=$1`,
      [id],
    );
    return result.rows[0];
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
      `INSERT INTO memberships (organization_seq,customer_seq,employee_no,role,status,department_seq)
       VALUES ($1,$2,$3,$4,'ACTIVE',$5) RETURNING membership_seq AS id`,
      [companyId, input.customerSeq, input.employeeNo, input.role, input.departmentSeq],
    );
    return result.rows[0].id;
  }

  async update(id: number, changes: UpdateMemberDto, client: PoolClient): Promise<void> {
    await client.query(
      'UPDATE memberships SET role=COALESCE($2,role),status=COALESCE($3,status),department_seq=COALESCE($4,department_seq) WHERE membership_seq=$1',
      [id, changes.role ?? null, changes.status ?? null, changes.departmentSeq ?? null],
    );
  }

  async remove(id: number, client: PoolClient): Promise<void> {
    await client.query('DELETE FROM memberships WHERE membership_seq=$1', [id]);
  }

  async department(companyId: number, departmentId: number, client: PoolClient): Promise<boolean> {
    return (
      (
        await client.query(
          'SELECT 1 FROM departments WHERE organization_seq=$1 AND department_seq=$2 FOR SHARE',
          [companyId, departmentId],
        )
      ).rowCount === 1
    );
  }

  async lockWrites(client: PoolClient): Promise<void> {
    // 고객을 잠그기 전에 소속·CSV 변경을 직렬화해 조회한 소속의 고객 연결을 유지한다.
    await client.query('SELECT pg_advisory_xact_lock(20261027,37)');
  }

  async candidates(
    companyId: number,
    rows: CsvMemberRow[],
    client: PoolClient,
  ): Promise<MemberCandidate[]> {
    const result = await client.query<MemberCandidate>(
      `SELECT c.customer_seq AS "customerSeq",c.name,c.phone_number AS "phoneNumber",c.status AS "customerStatus",
       m.membership_seq AS "membershipSeq",m.organization_seq AS "organizationSeq",m.employee_no AS "employeeNo"
       FROM customers c LEFT JOIN memberships m ON m.customer_seq=c.customer_seq
       WHERE c.phone_number=ANY($1::text[]) OR (m.organization_seq=$2 AND m.employee_no=ANY($3::text[]))`,
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

  async saveCsvCustomer(
    row: CsvMemberRow,
    existing: MemberCandidate | undefined,
    client: PoolClient,
  ): Promise<number> {
    if (existing) {
      if (existing.name !== row.name || existing.phoneNumber !== row.phoneNumber)
        await client.query('UPDATE customers SET name=$2,phone_number=$3 WHERE customer_seq=$1', [
          existing.customerSeq,
          row.name,
          row.phoneNumber,
        ]);
      return existing.customerSeq;
    }
    const result = await client.query<{ id: number }>(
      "INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE') RETURNING customer_seq AS id",
      [row.name, row.phoneNumber],
    );
    return result.rows[0].id;
  }
}
