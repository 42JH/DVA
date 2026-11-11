import { OrderCustomerWritesService } from './order-customer-writes.service';
import { CallScopeService } from '../call-scope/call-scope.service';
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
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer-request.dto';

@Injectable()
export class CustomersService {
  async removeMany(ids: number[], actorId: number, requestId: string): Promise<void> {
    const sorted = [...ids].sort((a, b) => a - b);
    try {
      await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        if ((await this.repository.lockMany(client, sorted)).length !== sorted.length)
          throw new ApiException(
            404,
            'NOT_FOUND',
            '삭제할 고객 중 찾을 수 없거나 이미 삭제된 고객이 있습니다.',
          );
        await this.repository.removeMany(client, sorted);
        for (const id of sorted)
          await this.audit.recordSuccess(
            {
              actorId,
              targetId: id,
              targetType: 'CUSTOMER',
              action: 'CUSTOMER_DELETED',
              requestId,
            },
            client,
          );
      });
    } catch (error: unknown) {
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

  constructor(
    private readonly repository: CustomersRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly calls: CallContextClient,
    private readonly scope: CallScopeService,
    private readonly orderWrites: OrderCustomerWritesService,
  ) {}

  lockOrderPhones(client: PoolClient, phones: string[]) {
    return this.orderWrites.lockPhones(client, phones);
  }

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
      await this.orderWrites.lockPhones(client, [input.phoneNumber]);
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
    callSessionHeader?: string,
  ): Promise<void> {
    const administrator = actorId !== null;
    const aiAddress = !administrator && changes.address !== undefined;
    if (
      changes.name === undefined &&
      changes.status === undefined &&
      changes.monthlyBillingEnabled === undefined &&
      changes.address === undefined
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '변경할 이름·상태·월결제 자격·주소를 입력해 주세요.',
      );
    if (
      (changes.status !== undefined || changes.monthlyBillingEnabled !== undefined) &&
      !administrator
    )
      throw new ApiException(403, 'FORBIDDEN', '고객 상태 변경은 관리자만 가능합니다.');
    if (
      aiAddress &&
      (callSessionHeader === undefined ||
        !/^[0-9]+(?![\s\S])/.test(callSessionHeader) ||
        Number(callSessionHeader) < 1 ||
        Number(callSessionHeader) > 2147483647)
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'AI 고객 기본 주소 수정에는 유효한 call_session_seq가 필요합니다.',
      );
    if (aiAddress && !this.scope.active) {
      await this.scope.execute({
        operation: 'CustomerUpdated',
        id,
        input: { ...changes },
        requestId,
        callSessionSeq: this.scope.header(callSessionHeader, true),
      });
      return;
    }
    await this.scope.transaction(async (client) => {
      const caller = aiAddress ? this.ongoingCaller() : undefined;
      const customer = await this.repository.find(id, client);
      if (!customer || (!administrator && customer.status === 'WITHDRAWN'))
        throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      if (
        caller &&
        (caller.phone !== customer.phoneNumber ||
          (caller.customerSeq !== null && caller.customerSeq !== id))
      )
        throw new ApiException(
          403,
          'FORBIDDEN',
          '해당 통화 고객의 기본 주소만 수정할 수 있습니다.',
        );
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
  private ongoingCaller() {
    const call = this.scope.caller;
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
    if (call.endedAt !== null)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '종료된 통화에서는 고객 기본 주소를 수정할 수 없습니다.',
      );
    if (!call.phone) throw new ApiException(403, 'FORBIDDEN', '통화 발신번호가 필요합니다.');
    return call;
  }
}
