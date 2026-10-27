import { Injectable } from '@nestjs/common';

import { PoolClient } from 'pg';

import { ApiException } from '../common/errors/api.exception';

import { ListResponse } from '../common/pagination';

import { MembersRepository } from './members.repository';

import { ListMembersQueryDto } from './dto/member-request.dto';

@Injectable()
export class MembersService {
  constructor(private readonly repository: MembersRepository) {}

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
}
