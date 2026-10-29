import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { MembersRepository } from './members.repository';
import { CreateMemberDto, ListMembersQueryDto, UpdateMemberDto } from './dto/member-request.dto';
import { CsvUpload, MemberCandidate } from './members.types';
import { parseMemberCsv } from './member-csv';

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

  private async write(work: (client: PoolClient) => Promise<void>) {
    try {
      await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout = '2s'");
        await this.repository.lockWrites(client);
        await work(client);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '55P03')
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '다른 작업의 완료 대기 시간을 초과했습니다. 잠시 후 재시도해 주세요.',
        );
      throw error;
    }
  }

  async create(
    companyId: number,
    input: CreateMemberDto,
    adminId: number,
    requestId: string,
  ): Promise<void> {
    await this.write(async (client) => {
      const customer = await this.repository.customer(input.customerSeq, client);
      if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      await this.company(companyId, client, true);
      if (!(await this.repository.department(companyId, input.departmentSeq, client)))
        throw new ApiException(422, 'VALIDATION_FAILED', '해당 기업의 부서를 지정해 주세요.');
      if (customer.status !== 'ACTIVE')
        throw new ApiException(409, 'INVALID_STATE', '탈퇴 고객은 등록할 수 없습니다.');
      const id = await this.repository.create(companyId, input, client);
      await this.record('MEMBERSHIP_CREATED', 'MEMBERSHIP', id, adminId, requestId, client);
    });
  }

  async update(
    id: number,
    input: UpdateMemberDto,
    adminId: number,
    requestId: string,
  ): Promise<void> {
    if (input.role === undefined && input.status === undefined && input.departmentSeq === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 표시 역할 또는 상태를 입력해 주세요.');
    await this.write(async (client) => {
      const member = await this.repository.member(id, client);
      if (!member) throw new ApiException(404, 'NOT_FOUND', '구성원을 찾을 수 없습니다.');
      // 고객을 기업·소속보다 먼저 잠가 주문과 잠금 순서가 뒤집히지 않게 한다.
      const customer = await this.repository.customer(member.customerSeq, client);
      await this.company(member.organizationSeq, client, input.status === 'ACTIVE');
      if (
        input.departmentSeq !== undefined &&
        !(await this.repository.department(member.organizationSeq, input.departmentSeq, client))
      )
        throw new ApiException(422, 'VALIDATION_FAILED', '해당 기업의 부서를 지정해 주세요.');
      if (input.status === 'ACTIVE') {
        if (!customer || customer.status !== 'ACTIVE')
          throw new ApiException(409, 'INVALID_STATE', '탈퇴 고객의 소속을 활성화할 수 없습니다.');
      }
      await this.repository.update(id, input, client);
      await this.record('MEMBERSHIP_UPDATED', 'MEMBERSHIP', id, adminId, requestId, client);
    });
  }

  async remove(id: number, adminId: number, requestId: string): Promise<void> {
    await this.write(async (client) => {
      const member = await this.repository.member(id, client);
      if (!member) throw new ApiException(404, 'NOT_FOUND', '구성원을 찾을 수 없습니다.');
      await this.repository.customer(member.customerSeq, client);
      await this.repository.remove(id, client);
      await this.record('MEMBERSHIP_REMOVED', 'MEMBERSHIP', id, adminId, requestId, client);
    });
  }

  async importCsv(
    companyId: number,
    file: CsvUpload | undefined,
    adminId: number,
    requestId: string,
  ): Promise<void> {
    const rows = parseMemberCsv(file);
    await this.write(async (client) => {
      const before = await this.repository.candidates(companyId, rows, client);
      await this.repository.lockCustomers(
        before.map((row) => row.customerSeq),
        client,
      );
      const candidates = await this.repository.candidates(companyId, rows, client);
      await this.company(companyId, client, true);
      for (const departmentId of [...new Set(rows.map((row) => row.departmentSeq))].sort(
        (a, b) => a - b,
      ))
        if (!(await this.repository.department(companyId, departmentId, client)))
          throw new ApiException(
            422,
            'VALIDATION_FAILED',
            'CSV에 해당 기업의 부서 번호를 지정해 주세요.',
          );
      const byPhone = new Map(candidates.map((row) => [row.phoneNumber, row]));
      const byEmployee = new Map(
        candidates
          .filter((row) => row.organizationSeq === companyId)
          .map((row) => [row.employeeNo, row]),
      );
      const errors: ErrorDetail[] = [];
      const plans: Array<MemberCandidate | undefined> = [];
      rows.forEach((row, index) => {
        const employee = byEmployee.get(row.employeeNo);
        const phoneOwner = byPhone.get(row.phoneNumber);
        const existing = employee ?? phoneOwner;
        const add = (field: string, reason: string) =>
          errors.push({ field: `rows[${index + 2}].${field}`, reason });
        if (existing?.customerStatus === 'WITHDRAWN') add('phoneNumber', 'CUSTOMER_WITHDRAWN');
        if (employee) {
          if (phoneOwner && phoneOwner.customerSeq !== employee.customerSeq)
            add('phoneNumber', 'PHONE_NUMBER_CONFLICT');
        } else if (phoneOwner?.membershipSeq) {
          add(
            'phoneNumber',
            phoneOwner.organizationSeq === companyId
              ? 'EMPLOYEE_NO_CONFLICT'
              : 'OTHER_COMPANY_MEMBERSHIP',
          );
        }
        plans.push(existing);
      });
      if (errors.length)
        throw new ApiException(
          422,
          'VALIDATION_FAILED',
          'CSV 행의 고객·소속 충돌을 확인해 주세요.',
          errors,
        );
      for (const [index, row] of rows.entries()) {
        const existing = plans[index];
        const customerSeq = await this.repository.saveCsvCustomer(row, existing, client);
        if (!existing?.membershipSeq)
          await this.repository.create(
            companyId,
            {
              customerSeq,
              employeeNo: row.employeeNo,
              role: 'MEMBER',
              departmentSeq: row.departmentSeq,
            },
            client,
          );
        else
          await this.repository.update(
            existing.membershipSeq,
            { departmentSeq: row.departmentSeq },
            client,
          );
      }
      await this.record('MEMBERS_IMPORTED', 'ORGANIZATION', companyId, adminId, requestId, client);
    });
  }
}
