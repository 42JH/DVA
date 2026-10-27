import { Injectable } from '@nestjs/common';

import { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

import { ListMembersQueryDto } from './dto/member-request.dto';

import { MemberViewDto } from './dto/member-response.dto';

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

  async list(companyId: number, query: ListMembersQueryDto): Promise<MemberViewDto[]> {
    const result = await this.database.pool.query<MemberViewDto>(
      `SELECT jsonb_build_object('membershipSeq',m.membership_seq,'customerSeq',m.customer_seq,
        'organizationSeq',m.organization_seq,'employeeNo',m.employee_no,'role',m.role,'status',m.status) AS membership,
        jsonb_build_object('customerSeq',c.customer_seq,'name',c.name,'phoneNumber',c.phone_number,'status',c.status) AS customer
       FROM memberships m JOIN customers c ON c.customer_seq=m.customer_seq
       WHERE m.organization_seq=$1 AND ($2::text IS NULL OR m.status=$2)
       ORDER BY m.membership_seq DESC LIMIT $3 OFFSET $4`,
      [companyId, query.status ?? null, query.limit + 1, query.offset],
    );
    return result.rows;
  }
}
