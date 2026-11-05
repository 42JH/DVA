import { CallContextClient } from './call-context.client';
import { CallerContextRequestDto } from './dto/caller-context.dto';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { CustomersRepository } from './customers.repository';
import { EmployeeCustomerIdentity } from './customers.types';
import { CreateCustomerDto, ListCustomersQueryDto } from './dto/customer-request.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly repository: CustomersRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly calls: CallContextClient,
  ) {}

  // 소속 충돌 검증과 고객 잠금을 마친 호출자의 같은 트랜잭션에 참여한다.
  async importEmployeeIdentities(client: PoolClient, rows: EmployeeCustomerIdentity[]) {
    await this.repository.updateIdentities(
      client,
      rows.filter((row) => row.customerSeq !== undefined),
    );
    const inserted = await this.repository.insertIdentities(
      client,
      rows.filter((row) => row.customerSeq === undefined),
    );
    const byPhone = new Map(inserted.map((row) => [row.phoneNumber, row.customerSeq]));
    return rows.map((row) => row.customerSeq ?? byPhone.get(row.phoneNumber)!);
  }

  async context(input: CallerContextRequestDto, actorId: number | null, requestId: string) {
    try {
      return input.call
        ? await this.calls.context(input, actorId, requestId)
        : await this.repository.context(input.phoneNumber);
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '고객 초기 정보를 조회할 수 없습니다.');
    }
  }

  list(query: ListCustomersQueryDto) {
    return this.repository.list(query).then((rows) => new ListResponse(rows, query.limit));
  }

  async find(id: number, administrator: boolean) {
    const customer = await this.repository.find(id);
    if (!customer || (!administrator && customer.status === 'WITHDRAWN'))
      throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    return customer;
  }

  async create(input: CreateCustomerDto, actorId: number | null, requestId: string) {
    if (actorId === null && input.monthlyBillingEnabled === true)
      throw new ApiException(403, 'FORBIDDEN', '월결제 자격은 관리자만 설정할 수 있습니다.');
    return this.database.transaction(async (client) => {
      const customerSeq = await this.repository.insert(client, input);
      await this.audit.recordSuccess(
        {
          actorId,
          actorType: actorId === null ? 'AI' : 'ADMIN',
          targetId: customerSeq,
          targetType: 'CUSTOMER',
          action: 'CUSTOMER_CREATED',
          requestId,
        },
        client,
      );
      return { customerSeq };
    });
  }
}
