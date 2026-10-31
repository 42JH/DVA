import { readPage } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  CreateDepartmentDto,
  DepartmentDto,
  DepartmentSummaryDto,
  UpdateDepartmentDto,
} from './dto/department.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
const columns =
  'department_seq AS "departmentSeq",organization_seq AS "organizationSeq",name,group_billing_enabled AS "groupBillingEnabled"';

@Injectable()
export class DepartmentsRepository {
  constructor(private readonly database: DatabaseService) {}
  async company(client: PoolClient, id: number) {
    return (
      await client.query<{ status: string }>(
        'SELECT status FROM organizations WHERE organization_seq=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
  }
  async list(id: number, query: PaginationQueryDto) {
    return await readPage<DepartmentSummaryDto>(
      this.database.pool,
      `SELECT ${columns},d.created_at AS "createdAt",
        (SELECT count(*)::integer FROM memberships m WHERE m.department_seq=d.department_seq
         AND m.organization_seq=d.organization_seq AND m.status='ACTIVE') AS "memberCount"
       FROM departments d WHERE d.organization_seq=$1`,
      [id],
      query,
      '"departmentSeq"',
    );
  }
  async find(client: PoolClient, id: number) {
    return (
      await client.query<DepartmentDto>(
        `SELECT ${columns} FROM departments WHERE department_seq=$1`,
        [id],
      )
    ).rows[0];
  }
  async insert(client: PoolClient, id: number, input: CreateDepartmentDto) {
    return (
      await client.query<{ departmentSeq: number }>(
        `INSERT INTO departments(organization_seq,name,group_billing_enabled) VALUES($1,$2,$3) RETURNING department_seq AS "departmentSeq"`,
        [id, input.name, input.groupBillingEnabled ?? false],
      )
    ).rows[0];
  }
  async update(client: PoolClient, id: number, input: UpdateDepartmentDto) {
    await client.query(
      'UPDATE departments SET name=COALESCE($2,name),group_billing_enabled=COALESCE($3,group_billing_enabled) WHERE department_seq=$1',
      [id, input.name ?? null, input.groupBillingEnabled ?? null],
    );
  }
  async renamePins(client: PoolClient, id: number, name: string) {
    return (
      await client.query<{ id: number }>(
        'UPDATE company_pins SET department_name=$2 WHERE department_seq=$1 AND department_name IS DISTINCT FROM $2 RETURNING company_pin_seq AS id',
        [id, name],
      )
    ).rows;
  }
}
