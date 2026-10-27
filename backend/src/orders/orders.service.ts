import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CustomersService } from '../customers/customers.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto } from './dto/order-response.dto';
import { orderDraft } from './order-draft';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
  ) {}

  async create(
    adminId: number,
    key: string,
    input: CreateOrderDto,
    requestId: string,
  ): Promise<CreatedOrderDto> {
    if ((input.customerSeq === undefined) === (input.customer === undefined))
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'customerSeq와 customer 중 하나만 전달해 주세요.',
        [{ field: 'customer', reason: 'exactlyOneCustomerReference' }],
      );
    const draft = orderDraft(input);
    const hash = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    return this.database.transaction(async (client) => {
      if (!(await this.repository.lockCreation(client, adminId, key)))
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '같은 주문 생성 요청을 처리 중입니다.');
      const previous = await this.repository.findCreation(client, adminId, key);
      if (previous) {
        if (previous.requestHash !== hash)
          throw new ApiException(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            '같은 요청 키에 다른 내용이 전달됐습니다.',
          );
        return { orderSeq: previous.orderSeq, version: previous.version };
      }
      const customerId = await this.customers.resolveForOrder(client, draft, adminId, requestId);
      for (const parcel of draft.parcels) {
        if (
          parcel.originPin &&
          !(await this.repository.canUsePin(client, customerId, parcel.originPin))
        )
          throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
      }
      const result = await this.repository.insert(client, draft, customerId);
      await this.repository.rememberCreation(client, adminId, key, hash, result);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: result.orderSeq,
          action: 'ORDER_CREATED',
          targetType: 'ORDER',
          requestId,
        },
        client,
      );
      return result;
    });
  }
}
