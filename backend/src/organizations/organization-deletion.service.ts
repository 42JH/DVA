import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { OrganizationDeletionRepository } from './organization-deletion.repository';

@Injectable()
export class OrganizationDeletionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrganizationDeletionRepository,
    private readonly audit: AuditService,
  ) {}

  async remove(id: number, departmentOnly: boolean, adminId: number, requestId: string) {
    try {
      await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        const owner = departmentOnly
          ? await this.repository.department(client, id)
          : { organizationSeq: id };
        if (!owner) throw new ApiException(404, 'NOT_FOUND', '부서를 찾을 수 없습니다.');
        const companyId = owner.organizationSeq,
          departmentId = departmentOnly ? id : null;
        await this.repository.lockMembers(client, companyId, departmentId);
        const company = await this.repository.company(client, companyId);
        if (!company) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
        const departments = await this.repository.departments(client, companyId, departmentId);
        if (departmentOnly && !departments.length)
          throw new ApiException(404, 'NOT_FOUND', '부서를 찾을 수 없습니다.');
        const context = { organizationSeq: companyId, organizationName: company.name };
        for (const member of await this.repository.removeMembers(client, companyId, departmentId))
          await this.audit.recordSuccess(
            {
              actorId: adminId,
              action: 'MEMBERSHIP_REMOVED',
              targetType: 'MEMBERSHIP',
              targetId: member.id,
              requestId,
              metadata: {
                ...context,
                customerSeq: member.customerSeq,
                departmentSeq: member.departmentSeq,
                departmentName:
                  departments.find((d) => d.id === member.departmentSeq)?.name ?? null,
              },
            },
            client,
          );
        await this.repository.removeDepartments(client, companyId, departmentId);
        for (const department of departments)
          await this.audit.recordSuccess(
            {
              actorId: adminId,
              action: 'DEPARTMENT_DELETED',
              targetType: 'DEPARTMENT',
              targetId: department.id,
              requestId,
              metadata: {
                ...context,
                departmentSeq: department.id,
                departmentName: department.name,
              },
            },
            client,
          );
        if (!departmentOnly) {
          await this.repository.removeCompany(client, companyId);
          await this.audit.recordSuccess(
            {
              actorId: adminId,
              action: 'ORGANIZATION_DELETED',
              targetType: 'ORGANIZATION',
              targetId: companyId,
              requestId,
              metadata: context,
            },
            client,
          );
        }
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['55P03', '40P01'].includes(String(error.code))
      )
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '다른 작업이 진행 중입니다. 잠시 후 재시도해 주세요.',
        );
      throw error;
    }
  }
}
