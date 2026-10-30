import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { OrganizationsService } from './organizations.service';
import { DepartmentsRepository } from './departments.repository';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: DepartmentsRepository,
    private readonly organizations: OrganizationsService,
    private readonly audit: AuditService,
  ) {}
  async list(id: number, query: PaginationQueryDto) {
    await this.organizations.find(id);
    return new ListResponse(await this.repository.list(id, query), query.limit);
  }
  async create(id: number, input: CreateDepartmentDto, adminId: number, requestId: string) {
    return this.database.transaction(async (client) => {
      const company = await this.repository.company(client, id);
      if (!company) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
      if (company.status !== 'ACTIVE')
        throw new ApiException(409, 'INVALID_STATE', '활성 기업에만 부서를 등록할 수 있습니다.');
      const result = await this.repository.insert(client, id, input);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: result.departmentSeq,
          targetType: 'DEPARTMENT',
          action: 'DEPARTMENT_CREATED',
          requestId,
        },
        client,
      );
      return result;
    });
  }
  async update(id: number, input: UpdateDepartmentDto, adminId: number, requestId: string) {
    if (input.name === undefined && input.groupBillingEnabled === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 부서 정보를 입력해 주세요.');
    await this.database.transaction(async (client) => {
      const department = await this.repository.find(client, id);
      if (!department) throw new ApiException(404, 'NOT_FOUND', '부서를 찾을 수 없습니다.');
      await this.repository.company(client, department.organizationSeq);
      if (!(await this.repository.find(client, id)))
        throw new ApiException(404, 'NOT_FOUND', '부서를 찾을 수 없습니다.');
      await this.repository.update(client, id, input);
      if (input.name !== undefined)
        for (const pin of await this.repository.renamePins(client, id, input.name))
          await this.audit.recordSuccess(
            {
              actorId: adminId,
              targetId: pin.id,
              targetType: 'COMPANY_PIN',
              action: 'COMPANY_PIN_UPDATED',
              requestId,
            },
            client,
          );
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          targetType: 'DEPARTMENT',
          action: 'DEPARTMENT_UPDATED',
          requestId,
        },
        client,
      );
    });
  }
}
