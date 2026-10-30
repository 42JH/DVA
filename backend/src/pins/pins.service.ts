import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import {
  CreateCompanyPinDto,
  CreatePinDto,
  ListPinsQueryDto,
  UpdateCompanyPinDto,
  UpdatePinDto,
} from './dto/pin-request.dto';
import { PinsRepository } from './pins.repository';

@Injectable()
export class PinsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PinsRepository,
    private readonly audit: AuditService,
  ) {}

  private async caller(client: PoolClient, header: string | undefined, lock: boolean) {
    if (
      header === undefined ||
      !/^[0-9]+(?![\s\S])/.test(header) ||
      Number(header) < 1 ||
      Number(header) > 2147483647
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'AI 주소록 API에는 유효한 call_session_seq가 필요합니다.',
      );
    const call = await this.repository.call(client, Number(header), lock);
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
    if (call.endedAt !== null)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '종료된 통화에서는 주소록을 사용할 수 없습니다.',
      );
    if (!call.phone) throw new ApiException(403, 'FORBIDDEN', '통화 발신번호가 필요합니다.');
    return call.phone;
  }

  private async personalAccess(
    client: PoolClient,
    customerId: number,
    adminId: number | null,
    header: string | undefined,
    write: boolean,
  ) {
    const phone = adminId === null ? await this.caller(client, header, write) : null;
    const customer = await this.repository.customer(client, customerId, write);
    if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    if (phone !== null && (phone !== customer.phone || customer.status !== 'ACTIVE'))
      throw new ApiException(
        403,
        'FORBIDDEN',
        '현재 통화의 활성 고객 주소록만 사용할 수 있습니다.',
      );
    if (customer.status !== 'ACTIVE')
      throw new ApiException(409, 'INVALID_STATE', '탈퇴 고객의 주소록은 사용할 수 없습니다.');
  }

  private async companyAccess(
    client: PoolClient,
    companyId: number,
    adminId: number | null,
    header: string | undefined,
    write: boolean,
  ) {
    if (write && adminId === null)
      throw new ApiException(403, 'FORBIDDEN', '기업 공유 주소록 변경은 관리자만 가능합니다.');
    if (adminId === null) {
      const phone = await this.caller(client, header, false);
      const membership = await this.repository.callerCompany(client, phone);
      if (membership?.organizationSeq !== companyId)
        throw new ApiException(
          403,
          'FORBIDDEN',
          '활성 소속 기업의 공유 주소록만 조회할 수 있습니다.',
        );
    }
    const company = await this.repository.company(client, companyId, write);
    if (!company) throw new ApiException(404, 'NOT_FOUND', '기업을 찾을 수 없습니다.');
    if (write && company.status !== 'ACTIVE')
      throw new ApiException(
        409,
        'INVALID_STATE',
        '비활성 기업의 공유 주소록은 변경할 수 없습니다.',
      );
  }

  private record(
    client: PoolClient,
    adminId: number | null,
    id: number,
    company: boolean,
    created: boolean,
    requestId: string,
  ) {
    const targetType = company ? 'COMPANY_PIN' : 'PERSONAL_PIN';
    return this.audit.recordSuccess(
      {
        actorId: adminId,
        actorType: adminId === null ? 'AI' : 'ADMIN',
        targetId: id,
        targetType,
        action: `${targetType}_${created ? 'CREATED' : 'UPDATED'}`,
        requestId,
      },
      client,
    );
  }

  listPersonal(
    customerId: number,
    query: ListPinsQueryDto,
    adminId: number | null,
    header?: string,
  ) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.personalAccess(client, customerId, adminId, header, false);
      return new ListResponse(
        await this.repository.personal(client, customerId, query),
        query.limit,
      );
    });
  }

  listCompany(companyId: number, query: ListPinsQueryDto, adminId: number | null, header?: string) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.companyAccess(client, companyId, adminId, header, false);
      return new ListResponse(await this.repository.shared(client, companyId, query), query.limit);
    });
  }

  createPersonal(
    customerId: number,
    input: CreatePinDto,
    adminId: number | null,
    requestId: string,
    header?: string,
  ) {
    return this.database.transaction(async (client) => {
      await this.personalAccess(client, customerId, adminId, header, true);
      const result = await this.repository.createPersonal(client, customerId, input);
      await this.record(client, adminId, result.personalPinSeq, false, true, requestId);
      return result;
    });
  }

  createCompany(
    companyId: number,
    input: CreateCompanyPinDto,
    adminId: number | null,
    requestId: string,
  ) {
    return this.database.transaction(async (client) => {
      await this.companyAccess(client, companyId, adminId, undefined, true);
      const department = await this.resolveDepartment(client, companyId, input);
      const result = await this.repository.createCompany(client, companyId, {
        ...input,
        ...department,
      });
      await this.record(client, adminId, result.companyPinSeq, true, true, requestId);
      return result;
    });
  }

  updatePersonal(
    id: number,
    input: UpdatePinDto,
    adminId: number | null,
    requestId: string,
    header?: string,
  ) {
    if (input.label === undefined && input.addressData === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 별칭 또는 완성 주소를 입력해 주세요.');
    return this.database.transaction(async (client) => {
      const customerId = await this.repository.owner(client, id, false);
      if (customerId === undefined)
        throw new ApiException(404, 'NOT_FOUND', '개인 주소록을 찾을 수 없습니다.');
      await this.personalAccess(client, customerId, adminId, header, true);
      const result = await this.repository.updatePersonal(client, id, input);
      if (!result) throw new ApiException(404, 'NOT_FOUND', '개인 주소록을 찾을 수 없습니다.');
      await this.record(client, adminId, id, false, false, requestId);
      return result;
    });
  }

  updateCompany(id: number, input: UpdateCompanyPinDto, adminId: number | null, requestId: string) {
    if (
      input.label === undefined &&
      input.addressData === undefined &&
      input.departmentSeq === undefined &&
      input.departmentName === undefined
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '변경할 별칭·부서명 또는 완성 주소를 입력해 주세요.',
      );
    return this.database.transaction(async (client) => {
      const companyId = await this.repository.owner(client, id, true);
      if (companyId === undefined)
        throw new ApiException(404, 'NOT_FOUND', '기업 주소록을 찾을 수 없습니다.');
      await this.companyAccess(client, companyId, adminId, undefined, true);
      const department =
        input.departmentSeq !== undefined || input.departmentName !== undefined
          ? await this.resolveDepartment(client, companyId, input)
          : {};
      const result = await this.repository.updateCompany(client, id, { ...input, ...department });
      if (!result) throw new ApiException(404, 'NOT_FOUND', '기업 주소록을 찾을 수 없습니다.');
      await this.record(client, adminId, id, true, false, requestId);
      return result;
    });
  }

  private async resolveDepartment(
    client: PoolClient,
    companyId: number,
    input: { departmentSeq?: number | null; departmentName?: string | null },
  ) {
    if (input.departmentSeq === null) {
      if (input.departmentName?.trim())
        throw new ApiException(
          422,
          'VALIDATION_FAILED',
          '기업 공용 PIN에는 부서명을 지정할 수 없습니다.',
        );
      return { departmentSeq: null, departmentName: null };
    }
    const rows = await this.repository.department(
      client,
      companyId,
      input.departmentSeq ?? null,
      input.departmentName ?? null,
    );
    if (input.departmentSeq !== undefined && !rows.length)
      throw new ApiException(422, 'VALIDATION_FAILED', '해당 기업의 부서를 지정해 주세요.');
    if (rows.length === 1) {
      if (
        input.departmentSeq !== undefined &&
        input.departmentName != null &&
        input.departmentName !== rows[0].name
      )
        throw new ApiException(422, 'VALIDATION_FAILED', '부서 번호와 이름이 일치하지 않습니다.');
      return { departmentSeq: rows[0].departmentSeq, departmentName: rows[0].name };
    }
    // Legacy free-text names stay unassigned until an operator confirms their department.
    return { departmentSeq: null, departmentName: input.departmentName ?? null };
  }
}
