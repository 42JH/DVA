import { Injectable } from '@nestjs/common';

import { createHash } from 'node:crypto';

import { PoolClient } from 'pg';

import { DatabaseService } from '../database/database.service';

import { ApiException } from '../common/errors/api.exception';

import { ListResponse } from '../common/pagination';

import { AuditService } from '../audit/audit.service';

import { MembersRepository } from './members.repository';

import { CreateMemberDto, ListMembersQueryDto } from './dto/member-request.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly repository: MembersRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async company(id: number, client?: PoolClient, active = false) {
    const company = await this.repository.company(id, client);
    if (!company) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
    if (active && company.status !== 'ACTIVE')
      throw new ApiException(409, 'INVALID_STATE', '활성 기업에만 등록·활성화할 수 있습니다.');
    return company;
  }

  async list(companyId: number, query: ListMembersQueryDto) {
    await this.company(companyId);
    return new ListResponse(await this.repository.list(companyId, query), query.limit);
  }

  private async lockWrites(client: PoolClient) {
    if (!(await this.repository.lockWrites(client)))
      throw new ApiException(
        409,
        'REQUEST_IN_PROGRESS',
        '다른 구성원 변경을 처리 중입니다. 잠시 후 재시도해 주세요.',
      );
  }

  private record(
    action: string,
    targetType: string,
    targetId: number,
    adminId: number,
    requestId: string,
    client: PoolClient,
  ) {
    return this.audit.recordSuccess(
      { action, targetType, targetId, actorId: adminId, requestId },
      client,
    );
  }

  private async writeOnce(
    companyId: number,
    adminId: number,
    key: string,
    operation: 'CREATE' | 'IMPORT',
    hash: string,
    work: (client: PoolClient) => Promise<void>,
  ) {
    await this.database.transaction(async (client) => {
      if (!(await this.repository.lockKey(client, adminId, key)))
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '같은 요청을 처리 중입니다.');
      const previous = await this.repository.receipt(adminId, key, client);
      if (previous) {
        if (previous.requestHash !== hash)
          throw new ApiException(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            '같은 키에 다른 기업·작업·내용이 전달됐습니다.',
          );
        return;
      }
      await this.lockWrites(client);
      await this.company(companyId, client, true);
      await work(client);
      await this.repository.remember(adminId, key, companyId, operation, hash, client);
    });
  }

  async create(
    companyId: number,
    input: CreateMemberDto,
    adminId: number,
    key: string,
    requestId: string,
  ): Promise<void> {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'CREATE',
          companyId,
          employeeNo: input.employeeNo,
          customerSeq: input.customerSeq,
          role: input.role,
        }),
      )
      .digest('hex');
    await this.writeOnce(companyId, adminId, key, 'CREATE', hash, async (client) => {
      const customer = await this.repository.customer(input.customerSeq, client);
      if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      if (customer.status !== 'ACTIVE')
        throw new ApiException(409, 'INVALID_STATE', '탈퇴 고객은 등록할 수 없습니다.');
      const id = await this.repository.create(companyId, input, client);
      await this.record('MEMBERSHIP_CREATED', 'MEMBERSHIP', id, adminId, requestId, client);
    });
  }
}
