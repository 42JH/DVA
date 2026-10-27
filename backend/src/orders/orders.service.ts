import { Injectable } from '@nestjs/common';
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
    adminId: number | null,
    key: string,
    input: CreateOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<CreatedOrderDto> {
    if ((input.customerSeq === undefined) === (input.customer === undefined))
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'customerSeq와 customer 중 하나만 전달해 주세요.',
        [{ field: 'customer', reason: 'exactlyOneCustomerReference' }],
      );
    if (
      (adminId === null && callSessionHeader === undefined) ||
      (callSessionHeader !== undefined &&
        (!/^[0-9]+$/.test(callSessionHeader) ||
          Number(callSessionHeader) < 1 ||
          Number(callSessionHeader) > 2147483647))
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'AI 주문 생성에는 유효한 X-Call-Session-Id가 필요합니다.',
      );
    const callId = callSessionHeader === undefined ? null : Number(callSessionHeader);
    const draft = orderDraft(input);
    return this.database.transaction(async (client) => {
      if (!(await this.repository.lockCreation(client, key)))
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '같은 주문 생성 요청을 처리 중입니다.');
      const previous = await this.repository.findCreation(client, key, adminId, callId);
      if (previous) {
        if (!previous.allowed)
          throw new ApiException(403, 'FORBIDDEN', '이 요청 키의 주문에 접근할 수 없습니다.');
        return { orderSeq: previous.orderSeq, version: previous.version };
      }
      const call = callId === null ? undefined : await this.repository.call(client, callId);
      if (callId !== null && !call)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (call && (call.endedAt !== null || call.orderSeq !== null))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '종료되었거나 주문이 연결된 통화입니다. 기존 주문을 사용해 주세요.',
        );
      const customer = await this.customers.resolveForOrder(client, draft, adminId, requestId);
      if (call?.phone && call.phone !== customer.phoneNumber)
        throw new ApiException(403, 'FORBIDDEN', '통화 발신번호와 주문 고객이 일치하지 않습니다.');
      const customerId = customer.customerSeq;
      for (const parcel of draft.parcels) {
        if (
          parcel.originPin &&
          !(await this.repository.canUsePin(client, customerId, parcel.originPin))
        )
          throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
      }
      const result = await this.repository.insert(client, draft, customerId, key);
      if (callId !== null) await this.repository.linkCall(client, callId, result.orderSeq);
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
