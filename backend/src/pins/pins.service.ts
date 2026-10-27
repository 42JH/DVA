import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { ListPinsQueryDto } from './dto/pin-request.dto';
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
}
