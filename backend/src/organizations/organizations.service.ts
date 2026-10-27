import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsRepository } from './organizations.repository';
import { AuditService } from '../audit/audit.service';
import { CompanyDirectoryQueryDto } from './dto/company-directory.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async searchDirectory(query: CompanyDirectoryQueryDto) {
    return new ListResponse(await this.repository.searchDirectory(query), query.limit);
  }

  async list(query: ListOrganizationsQueryDto) {
    return new ListResponse(await this.repository.list(query), query.limit);
  }

  async find(id: number) {
    const result = await this.repository.find(id);
    if (!result) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
    return result;
  }

  async update(
    id: number,
    changes: UpdateOrganizationDto,
    adminId: number,
    requestId: string,
  ): Promise<void> {
    if (changes.name === undefined && changes.status === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 기업명 또는 상태를 입력해 주세요.');
    await this.database.transaction(async (client) => {
      if (!(await this.repository.update(id, changes, client)))
        throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          action: 'ORGANIZATION_UPDATED',
          targetType: 'ORGANIZATION',
          requestId,
        },
        client,
      );
    });
  }

  async create(adminId: number, input: CreateOrganizationDto, requestId: string) {
    return this.database.transaction(async (client) => {
      const id = await this.repository.insert(client, input.name);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          action: 'ORGANIZATION_CREATED',
          targetType: 'ORGANIZATION',
          requestId,
        },
        client,
      );
      return { organizationSeq: id };
    });
  }
}
