import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { CustomersRepository } from './customers.repository';

@Injectable()
export class CustomersService {
  constructor(
    private readonly repository: CustomersRepository,
    private readonly audit: AuditService,
  ) {}

  async resolveForOrder(
    client: PoolClient,
    input: { customerSeq?: number; customer?: { name: string; phoneNumber: string } },
    actorId: number,
    requestId: string,
  ): Promise<number> {
    const created = input.customer
      ? await this.repository.insertIfNew(client, input.customer)
      : undefined;
    // 충돌한 INSERT가 다른 트랜잭션을 기다렸다면 새 SELECT에서 커밋된 고객을 읽는다.
    const customer =
      created ??
      (input.customer
        ? await this.repository.findByPhone(client, input.customer.phoneNumber)
        : await this.repository.findById(client, input.customerSeq!));
    if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    if (customer.status !== 'ACTIVE')
      throw new ApiException(403, 'FORBIDDEN', '활성 고객의 주문만 생성할 수 있습니다.');
    if (created)
      await this.audit.recordSuccess(
        {
          actorId,
          requestId,
          targetId: customer.id,
          targetType: 'CUSTOMER',
          action: 'CUSTOMER_CREATED',
        },
        client,
      );
    return customer.id;
  }
}
