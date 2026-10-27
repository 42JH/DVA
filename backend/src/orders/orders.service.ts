import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CustomersService } from '../customers/customers.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto } from './dto/order-response.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { ListResponse } from '../common/pagination';
import { isZonedDate, orderDraft } from './order-draft';
import { OrdersRepository } from './orders.repository';
import { UpdateOrderDto, UpdatedOrderDto } from './dto/update-order.dto';
import { assertOrderUpdate } from './order-update.validation';

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
  ) {}

  private callId(adminId: number | null, header?: string): number | null {
    if (
      (adminId === null && header === undefined) ||
      (header !== undefined &&
        (!/^[0-9]+$/.test(header) || Number(header) < 1 || Number(header) > 2147483647))
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'AI 주문 API에는 유효한 call_session_seq가 필요합니다.',
      );
    return header === undefined ? null : Number(header);
  }

  private async readCustomer(
    client: PoolClient,
    adminId: number | null,
    callId: number | null,
    orderId?: number,
  ) {
    if (adminId !== null) return null;
    const call = await this.repository.readCustomer(client, callId!);
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
    if (call.endedAt !== null && call.orderSeq !== orderId)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '종료된 통화는 기존 연결 주문의 상세만 조회할 수 있습니다.',
      );
    if (call.customerSeq === null)
      throw new ApiException(403, 'FORBIDDEN', '통화 발신번호에 연결된 활성 고객이 필요합니다.');
    return call.customerSeq;
  }

  async list(adminId: number | null, query: OrderQueryDto, callSessionHeader?: string) {
    const callId = this.callId(adminId, callSessionHeader);
    if (
      (query.from !== undefined && !isZonedDate(query.from)) ||
      (query.to !== undefined && !isZonedDate(query.to)) ||
      (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '조회 기간을 확인해 주세요. from은 to보다 빨라야 합니다.',
      );
    return this.database.transaction(async (client) => {
      // 통화의 고객 범위와 주문 목록을 같은 시점의 데이터로 읽는다.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const customerId = await this.readCustomer(client, adminId, callId);
      if (
        customerId !== null &&
        query.customerSeq !== undefined &&
        query.customerSeq !== customerId
      )
        throw new ApiException(403, 'FORBIDDEN', '다른 고객의 주문은 조회할 수 없습니다.');
      return new ListResponse(
        await this.repository.list(client, query, customerId ?? query.customerSeq ?? null),
        query.limit,
      );
    });
  }

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
    const callId = this.callId(adminId, callSessionHeader);
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

  async update(
    adminId: number | null,
    id: number,
    input: UpdateOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<UpdatedOrderDto> {
    assertOrderUpdate(input);
    const callId = this.callId(adminId, callSessionHeader);
    return this.database.transaction(async (client) => {
      const call = callId === null ? undefined : await this.repository.call(client, callId);
      if (callId !== null && !call)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (call && call.orderSeq !== null && call.orderSeq !== id)
        throw new ApiException(409, 'INVALID_STATE', '통화에 이미 다른 주문이 연결되어 있습니다.');
      if (call && call.endedAt !== null && call.orderSeq !== id)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '종료된 통화는 기존 연결 주문만 저장할 수 있습니다.',
        );
      const order = await this.repository.lockOrder(client, id);
      if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      if (order.customerSeq === null)
        throw new ApiException(403, 'FORBIDDEN', '주문에 연결된 고객이 필요합니다.');
      const customer = await this.customers.resolveForOrder(
        client,
        { customerSeq: order.customerSeq },
        adminId,
        requestId,
      );
      if (
        (adminId === null && !call?.phone) ||
        (call?.phone && call.phone !== customer.phoneNumber)
      )
        throw new ApiException(403, 'FORBIDDEN', '통화 발신번호와 주문 고객이 일치하지 않습니다.');
      if (order.status !== 'COLLECTING')
        throw new ApiException(409, 'INVALID_STATE', 'COLLECTING 주문만 수정할 수 있습니다.');
      if (order.version !== input.expectedVersion)
        throw new ApiException(
          409,
          'VERSION_CONFLICT',
          '주문이 변경되었습니다. 최신 내용을 조회해 주세요.',
        );

      const parcels = await this.repository.parcelReferences(client, id);
      const byId = new Map(parcels.map((parcel) => [parcel.orderParcelSeq, parcel]));
      let position = parcels.at(-1)?.parcelPosition ?? 0;
      for (const change of input.parcels ?? []) {
        const previous =
          change.orderParcelSeq === undefined ? undefined : byId.get(change.orderParcelSeq);
        if (change.orderParcelSeq !== undefined && !previous)
          throw new ApiException(404, 'NOT_FOUND', '해당 주문의 상세를 찾을 수 없습니다.');
        const pin = change.originPin === undefined ? previous?.originPin : change.originPin;
        if (pin && !(await this.repository.canUsePin(client, customer.customerSeq, pin)))
          throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
      }
      await this.repository.updateHeader(client, id, input);
      for (const change of input.parcels ?? []) {
        if (change.orderParcelSeq !== undefined)
          await this.repository.updateParcel(client, id, change);
        else
          await this.repository.insertParcel(
            client,
            id,
            ++position,
            orderDraft({ parcels: [change] }).parcels[0],
          );
      }
      if (call && call.orderSeq === null) await this.repository.linkCall(client, callId!, id);
      await this.audit.recordSuccess(
        { actorId: adminId, targetId: id, action: 'ORDER_UPDATED', targetType: 'ORDER', requestId },
        client,
      );
      return this.repository.currentVersion(client, id);
    });
  }

  async detail(adminId: number | null, id: number, callSessionHeader?: string) {
    const callId = this.callId(adminId, callSessionHeader);
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const customerId = await this.readCustomer(client, adminId, callId, id);
      const order = await this.repository.detail(client, id, customerId);
      if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      return order;
    });
  }
}
