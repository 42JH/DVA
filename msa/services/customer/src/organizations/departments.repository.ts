import { readPage } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { DepartmentSummaryDto } from './dto/department.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

const columns =
  'department_seq AS "departmentSeq",organization_seq AS "organizationSeq",name,group_billing_enabled AS "groupBillingEnabled"';

@Injectable()
export class DepartmentsRepository {
  constructor(private readonly database: DatabaseService) {}
  async list(id: number, query: PaginationQueryDto) {
    return await readPage<DepartmentSummaryDto>(
      this.database.pool,
      `SELECT ${columns},d.created_at AS "createdAt",
        (SELECT count(*)::integer FROM memberships m WHERE m.department_seq=d.department_seq
         AND m.organization_seq=d.organization_seq AND m.status='ACTIVE' AND m.deleted_at IS NULL) AS "memberCount"
       FROM departments d WHERE d.organization_seq=$1 AND d.deleted_at IS NULL`,
      [id],
      query,
      '"departmentSeq"',
    );
  }
}
