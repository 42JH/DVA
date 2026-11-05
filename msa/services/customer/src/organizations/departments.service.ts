import { Injectable } from '@nestjs/common';
import { ListResponse } from '../common/pagination';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { OrganizationsService } from './organizations.service';
import { DepartmentsRepository } from './departments.repository';

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly repository: DepartmentsRepository,
    private readonly organizations: OrganizationsService,
  ) {}
  async list(id: number, query: PaginationQueryDto) {
    await this.organizations.find(id);
    return new ListResponse(await this.repository.list(id, query), query.limit);
  }
}
