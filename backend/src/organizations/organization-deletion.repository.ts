import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

@Injectable()
export class OrganizationDeletionRepository {
  async department(client: PoolClient, id: number) {
    return (
      await client.query<{ organizationSeq: number }>(
        'SELECT organization_seq AS "organizationSeq" FROM departments WHERE department_seq=$1 AND deleted_at IS NULL',
        [id],
      )
    ).rows[0];
  }
  async lockMembers(client: PoolClient, company: number, department: number | null) {
    // Share the membership lock, then lock customers before company rows as payment does.
    await client.query('SELECT pg_advisory_xact_lock(20261027,37)');
    await client.query(
      `SELECT c.customer_seq FROM customers c JOIN memberships m USING(customer_seq)
      WHERE m.organization_seq=$1 AND m.deleted_at IS NULL AND ($2::int IS NULL OR m.department_seq=$2) ORDER BY c.customer_seq FOR UPDATE OF c`,
      [company, department],
    );
  }
  async company(client: PoolClient, id: number) {
    return (
      await client.query<{ name: string }>(
        'SELECT name FROM organizations WHERE organization_seq=$1 AND deleted_at IS NULL FOR UPDATE',
        [id],
      )
    ).rows[0];
  }
  async departments(client: PoolClient, company: number, department: number | null) {
    return (
      await client.query<{ id: number; name: string }>(
        'SELECT department_seq AS id,name FROM departments WHERE organization_seq=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR department_seq=$2) ORDER BY department_seq FOR UPDATE',
        [company, department],
      )
    ).rows;
  }
  async removeMembers(client: PoolClient, company: number, department: number | null) {
    return (
      await client.query<{ id: number; customerSeq: number; departmentSeq: number | null }>(
        `UPDATE memberships SET deleted_at=clock_timestamp() WHERE organization_seq=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR department_seq=$2)
       RETURNING membership_seq AS id,customer_seq AS "customerSeq",department_seq AS "departmentSeq"`,
        [company, department],
      )
    ).rows;
  }
  async removePins(client: PoolClient, company: number, department: number | null) {
    return (
      await client.query<{
        id: number;
        departmentSeq: number | null;
        departmentName: string | null;
      }>(
        `UPDATE company_pins SET deleted_at=clock_timestamp() WHERE organization_seq=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR department_seq=$2)
       RETURNING company_pin_seq AS id,department_seq AS "departmentSeq",department_name AS "departmentName"`,
        [company, department],
      )
    ).rows;
  }
  async removeDepartments(client: PoolClient, company: number, department: number | null) {
    await client.query(
      'UPDATE departments SET deleted_at=clock_timestamp() WHERE organization_seq=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR department_seq=$2)',
      [company, department],
    );
  }
  async removeCompany(client: PoolClient, id: number) {
    await client.query(
      'UPDATE organizations SET deleted_at=clock_timestamp() WHERE organization_seq=$1 AND deleted_at IS NULL',
      [id],
    );
  }
}
