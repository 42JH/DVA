import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { CreatePinDto, ListPinsQueryDto, UpdatePinDto } from './dto/pin-request.dto';
import { PinsRepository } from './pins.repository';

@Injectable()
export class PinsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PinsRepository,
    private readonly audit: AuditService,
  ) {}

  async removeMany(ids: number[], actorId: number, requestId: string): Promise<void> {
    const sorted = [...ids].sort((a, b) => a - b);
    try {
      await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        if ((await this.repository.lockForRemoval(client, sorted)).length !== sorted.length)
          throw new ApiException(
            404,
            'NOT_FOUND',
            '삭제할 주소록 중 찾을 수 없거나 이미 삭제된 주소록이 있습니다.',
          );
        await this.repository.removeMany(client, sorted);
        for (const id of sorted)
          await this.audit.recordSuccess(
            {
              actorId,
              targetId: id,
              targetType: 'PERSONAL_PIN',
              action: 'PERSONAL_PIN_DELETED',
              requestId,
            },
            client,
          );
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
    if (call.endedAt !== null && !lock)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '종료된 통화에서는 주소록을 조회할 수 없습니다.',
      );
    if (!call.phone) throw new ApiException(403, 'FORBIDDEN', '통화 발신번호가 필요합니다.');
    return call;
  }

  private async personalAccess(
    client: PoolClient,
    customerId: number,
    adminId: number | null,
    header: string | undefined,
    write: boolean,
  ) {
    const call = adminId === null ? await this.caller(client, header, write) : null;
    const customer = await this.repository.customer(client, customerId, write);
    if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    if (
      call !== null &&
      (call.phone !== customer.phone ||
        (call.customerSeq !== null && call.customerSeq !== customerId) ||
        customer.status !== 'ACTIVE')
    )
      throw new ApiException(
        403,
        'FORBIDDEN',
        '해당 통화의 활성 고객 주소록만 사용할 수 있습니다.',
      );
    if (customer.status !== 'ACTIVE')
      throw new ApiException(409, 'INVALID_STATE', '탈퇴 고객의 주소록은 사용할 수 없습니다.');
  }

  private record(
    client: PoolClient,
    adminId: number | null,
    id: number,
    created: boolean,
    requestId: string,
  ) {
    const targetType = 'PERSONAL_PIN';
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
    return this.database.readSnapshot(async (client) => {
      await this.personalAccess(client, customerId, adminId, header, false);
      return new ListResponse(
        await this.repository.personal(client, customerId, query),
        query.limit,
      );
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
      await this.record(client, adminId, result.personalPinSeq, true, requestId);
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
      const customerId = await this.repository.owner(client, id);
      if (customerId === undefined)
        throw new ApiException(404, 'NOT_FOUND', '개인 주소록을 찾을 수 없습니다.');
      await this.personalAccess(client, customerId, adminId, header, true);
      const result = await this.repository.updatePersonal(client, id, input);
      if (!result) throw new ApiException(404, 'NOT_FOUND', '개인 주소록을 찾을 수 없습니다.');
      await this.record(client, adminId, id, false, requestId);
      return result;
    });
  }
}
