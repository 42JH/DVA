import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { OrganizationsRepository } from './organizations.repository';

@Injectable()
export class OrganizationsService {
  constructor(private readonly repository: OrganizationsRepository) {}

  async list(query: ListOrganizationsQueryDto) {
    return new ListResponse(await this.repository.list(query), query.limit);
  }

  async find(id: number) {
    const result = await this.repository.find(id);
    if (!result) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
    return result;
  }
}
