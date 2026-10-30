import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { CustomersRepository } from './customers.repository';
import { CallerContextRequestDto } from './dto/caller-context.dto';
import { CallSessionRepository } from '../consultations/call-session.repository';
import { callerPhone } from '../common/caller-phone';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer-request.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly repository: CustomersRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly calls: CallSessionRepository,
  ) {}

  async context(input: CallerContextRequestDto, actorId: number | null, requestId: string) {
    try {
      const call = input.call;
      if (!call) return await this.repository.context(input.phoneNumber);
      const phoneNumber = callerPhone(input.phoneNumber);
      if (!/^[0-9]{3,20}$/.test(phoneNumber))
        throw new ApiException(400, 'INVALID_REQUEST', '통화 발신번호는 3~20자리 숫자여야 합니다.');
      return await this.database.transaction(async (client) => {
        const session = await this.calls.ensureCall(client, {
          ...call,
          callerPhoneNumber: phoneNumber,
        });
        const context = await this.repository.context(phoneNumber, client);
        if (session.created)
          await this.audit.recordSuccess(
            {
              actorId,
              actorType: actorId === null ? 'AI' : 'ADMIN',
              action: 'CALL_STARTED',
              targetType: 'CALL_SESSION',
              targetId: session.id,
              requestId,
            },
            client,
          );
        return { ...context, callSessionSeq: session.id };
      });
    } catch (error) {
      if (error instanceof ApiException) throw error;
      // 조회 장애를 미등록 고객으로 바꾸거나 일부 주소록만 성공으로 반환하지 않는다.
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '고객 초기 정보를 조회할 수 없습니다.');
    }
  }

  async resolveForOrder(
    client: PoolClient,
    input: { customerSeq?: number; customer?: CreateCustomerDto },
    actorId: number | null,
    requestId: string,
  ) {
    const created = input.customer
      ? await this.repository.insertForOrder(client, input.customer)
      : undefined;
    // 충돌한 INSERT가 다른 트랜잭션을 기다렸다면 새 SELECT에서 커밋된 고객을 읽는다.
    const customer =
      created ??
      (input.customer
        ? await this.repository.findByPhoneForOrder(client, input.customer.phoneNumber)
        : await this.repository.find(input.customerSeq!, client));
    if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    if (customer.status !== 'ACTIVE')
      throw new ApiException(403, 'FORBIDDEN', '주문에는 활성 고객이 필요합니다.');
    if (created)
      await this.audit.recordSuccess(
        {
          actorId,
          actorType: actorId === null ? 'AI' : 'ADMIN',
          requestId,
          targetId: customer.customerSeq,
          targetType: 'CUSTOMER',
          action: 'CUSTOMER_CREATED',
        },
        client,
      );
    return customer;
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

  async update(
    id: number,
    changes: UpdateCustomerDto,
    actorId: number | null,
    requestId: string,
  ): Promise<void> {
    const administrator = actorId !== null;
    if (
      changes.name === undefined &&
      changes.status === undefined &&
      changes.monthlyBillingEnabled === undefined
    )
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 이름 또는 상태를 입력해 주세요.');
    if (
      (changes.status !== undefined || changes.monthlyBillingEnabled !== undefined) &&
      !administrator
    )
      throw new ApiException(403, 'FORBIDDEN', '고객 상태 변경은 관리자만 가능합니다.');
    await this.database.transaction(async (client) => {
      const customer = await this.repository.find(id, client);
      if (!customer || (!administrator && customer.status === 'WITHDRAWN'))
        throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      if (customer.status === 'WITHDRAWN' && changes.status === 'ACTIVE')
        throw new ApiException(409, 'INVALID_STATE', '탈퇴 고객의 복구는 지원하지 않습니다.');
      await this.repository.update(id, changes, client);
      await this.audit.recordSuccess(
        {
          actorId,
          actorType: administrator ? 'ADMIN' : 'AI',
          targetId: id,
          targetType: 'CUSTOMER',
          action: 'CUSTOMER_UPDATED',
          requestId,
        },
        client,
      );
    });
  }
}
