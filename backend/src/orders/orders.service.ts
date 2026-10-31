import { AdminOrderListQueryDto } from './dto/admin-order-list.dto';
import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CustomersService } from '../customers/customers.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto, OrderResultDto } from './dto/order-response.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { ListResponse } from '../common/pagination';
import { isZonedDate, orderDraft } from './order-draft';
import { OrdersRepository } from './orders.repository';
import { UpdateOrderDto, UpdatedOrderDto } from './dto/update-order.dto';
import { assertOrderUpdate } from './order-update.validation';
import { DverClient, DverResult, dverPayload } from './dver.client';
import { OrderSubmissionRepository } from './order-submission.repository';
import { SubmitOrderDto, SubmittedOrderDto } from './dto/submit-order.dto';
import { callerPhone } from '../common/caller-phone';
import { OrderAddressHistoryQueryDto } from './dto/order-address-history.dto';
import { CreateManualOrderDto, ManualOrderResultDto } from './dto/manual-order.dto';
import { ConsultationsService } from '../consultations/consultations.service';
import { assertOrderAmount } from './order-pricing';
import { OrderPaymentsRepository } from './order-payments.repository';
import { assertOrderSubmissionReady } from './order-submission.validation';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly submissions: OrderSubmissionRepository,
    private readonly dver: DverClient,
    private readonly calls: ConsultationsService,
    private readonly payments: OrderPaymentsRepository,
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

  private async write<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout = '2s'");
        return work(client);
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
        '종료된 통화는 기존 연결 주문만 사용할 수 있습니다.',
      );
    if (call.customerSeq === null)
      throw new ApiException(403, 'FORBIDDEN', '통화 발신번호에 연결된 활성 고객이 필요합니다.');
    return call.customerSeq;
  }

  async adminList(query: AdminOrderListQueryDto) {
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
    return new ListResponse(
      await this.repository.adminList(this.database.pool, query),
      query.limit,
    );
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

  async addressHistory(
    adminId: number | null,
    customerId: number,
    query: OrderAddressHistoryQueryDto,
    header?: string,
  ) {
    const callId = this.callId(adminId, header);
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
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const callerCustomer = await this.readCustomer(client, adminId, callId);
      if (callerCustomer !== null && callerCustomer !== customerId)
        throw new ApiException(
          403,
          'FORBIDDEN',
          '다른 고객의 이전 주문 주소는 조회할 수 없습니다.',
        );
      if (callerCustomer === null && !(await this.repository.customerExists(client, customerId)))
        throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      return new ListResponse(
        await this.repository.addressHistory(client, customerId, query),
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
  ): Promise<CreatedOrderDto | OrderResultDto> {
    return this.createOrder(adminId, key, input, requestId, callSessionHeader);
  }

  async createManual(
    adminId: number,
    key: string,
    input: CreateManualOrderDto,
    requestId: string,
  ): Promise<ManualOrderResultDto> {
    const result = (await this.createOrder(
      adminId,
      key,
      input,
      requestId,
      undefined,
      true,
    )) as OrderResultDto;
    return {
      orderSeq: result.orderSeq,
      version: result.version,
      status: result.status,
      parcelNo: result.parcelNo,
      creationSource: 'ADMIN',
      totalAmount: result.totalAmount,
      paymentRequest: result.paymentRequest,
      paymentDueAt: result.paymentDueAt,
    };
  }

  private async createOrder(
    adminId: number | null,
    key: string,
    input: CreateOrderDto,
    requestId: string,
    callSessionHeader?: string,
    submitManual = false,
  ): Promise<CreatedOrderDto | OrderResultDto> {
    const partialResult = input.call && input.outcome !== 'COMPLETE';
    if ((input.call === undefined) !== (input.outcome === undefined))
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'AI 결과에는 call과 outcome을 함께 전달해 주세요.',
      );
    if (
      (input.customerSeq !== undefined && input.customer !== undefined) ||
      (!partialResult && input.customerSeq === undefined && input.customer === undefined)
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'customerSeq와 customer 중 하나만 전달해 주세요.',
        [{ field: 'customer', reason: 'exactlyOneCustomerReference' }],
      );
    const headerId = this.callId(input.call ? 0 : adminId, callSessionHeader);
    const draft = orderDraft(input);
    const prepared = await this.write(async (client) => {
      if (!(await this.repository.lockCreation(client, key)))
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '같은 주문 생성 요청을 처리 중입니다.');
      const callId = input.call
        ? await this.calls.ensureCall(client, input.call, adminId, requestId)
        : headerId;
      if (input.call && headerId !== null && headerId !== callId)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '본문 세션과 call_session_seq가 일치하지 않습니다.',
        );
      const previous = await this.repository.findCreation(client, key, adminId, callId);
      if (previous) {
        if (!previous.allowed)
          throw new ApiException(403, 'FORBIDDEN', '이 요청 키의 주문에 접근할 수 없습니다.');
        if (submitManual && previous.creationSource !== 'ADMIN')
          throw new ApiException(409, 'INVALID_STATE', '관리자 수기 주문의 요청 키가 아닙니다.');
        if (!input.call && !submitManual)
          return { result: { orderSeq: previous.orderSeq, version: previous.version } };
        if (await this.submissions.markStale(client, previous.orderSeq))
          await this.audit.recordSuccess(
            {
              actorId: null,
              actorType: 'SYSTEM',
              targetId: previous.orderSeq,
              targetType: 'ORDER',
              action: 'ORDER_SUBMISSION_FAILED',
              requestId,
            },
            client,
          );
        return { result: await this.repository.result(client, previous.orderSeq, callId) };
      }
      const call = callId === null ? undefined : await this.repository.call(client, callId);
      if (callId !== null && !call)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (call && ((!input.call && call.endedAt !== null) || call.orderSeq !== null))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '종료되었거나 주문이 연결된 통화입니다. 기존 주문을 사용해 주세요.',
        );
      const customer =
        draft.customerSeq !== undefined || draft.customer !== undefined
          ? await this.customers.resolveForOrder(client, draft, adminId, requestId)
          : await this.repository.customerByPhone(client, call!.phone!);
      if (
        call?.phone &&
        customer &&
        'phoneNumber' in customer &&
        callerPhone(call.phone) !== customer.phoneNumber
      )
        throw new ApiException(403, 'FORBIDDEN', '통화 발신번호와 주문 고객이 일치하지 않습니다.');
      const customerId = customer?.customerSeq ?? null;
      for (const parcel of draft.parcels) {
        if (
          parcel.originPin &&
          (customerId === null ||
            !(await this.repository.canUsePin(client, customerId, parcel.originPin)))
        )
          throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
      }
      const result = await this.repository.insert(
        client,
        draft,
        customerId,
        key,
        callId !== null ? 'AI' : 'ADMIN',
      );
      if (callId !== null) await this.calls.attachOrder(client, callId, result.orderSeq);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: adminId === null ? 'AI' : 'ADMIN',
          targetId: result.orderSeq,
          action: 'ORDER_CREATED',
          targetType: 'ORDER',
          requestId,
        },
        client,
      );
      if (!input.call && !submitManual) return { result };
      if (input.outcome === 'CANCELLED') {
        await this.repository.cancel(client, result.orderSeq);
        await this.repository.recalculateAmount(client, result.orderSeq);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            actorType: adminId === null ? 'AI' : 'ADMIN',
            targetId: result.orderSeq,
            targetType: 'ORDER',
            action: 'ORDER_CANCELLED',
            requestId,
            metadata: { amountBefore: draft.totalAmount, amountAfter: 0 },
          },
          client,
        );
      }
      const payload =
        input.outcome === 'COMPLETE' || submitManual
          ? await this.prepareSubmission(client, result.orderSeq, customerId!, adminId, requestId)
          : undefined;
      return { result: await this.repository.result(client, result.orderSeq, callId), payload };
    });
    if (!prepared.payload) return prepared.result;
    await this.submitPaidOrder(prepared.result.orderSeq, requestId);
    try {
      return await this.database.transaction((client) =>
        this.repository.result(
          client,
          prepared.result.orderSeq,
          (prepared.result as OrderResultDto).callSessionSeq,
        ),
      );
    } catch {
      // 결과 조회도 실패하면 성공으로 안내하지 않는다. 같은 키 재전송으로 확인한다.
      return prepared.result;
    }
  }

  async update(
    adminId: number | null,
    id: number,
    input: UpdateOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<UpdatedOrderDto> {
    assertOrderUpdate(input);
    if (adminId === null && input.removeParcelSeqs !== undefined)
      throw new ApiException(403, 'FORBIDDEN', '배송상세 제거는 관리자만 할 수 있습니다.');
    const callId = this.callId(adminId, callSessionHeader);
    return this.write(async (client) => {
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
      if (adminId === null && order.status !== 'COLLECTING')
        throw new ApiException(409, 'INVALID_STATE', 'AI는 COLLECTING 주문만 수정할 수 있습니다.');
      if (order.version !== input.expectedVersion)
        throw new ApiException(
          409,
          'VERSION_CONFLICT',
          '주문이 변경되었습니다. 최신 내용을 조회해 주세요.',
        );

      if (adminId !== null) {
        if (
          order.status !== 'COLLECTING' &&
          input.paymentMethodType !== undefined &&
          input.paymentMethodType !== order.paymentMethodType
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '확정된 주문의 결제수단은 변경할 수 없습니다.',
          );
        if (await this.payments.isApproving(client, id))
          throw new ApiException(
            409,
            'REQUEST_IN_PROGRESS',
            '결제 승인 처리 중에는 수정할 수 없습니다.',
          );
        await client.query("SELECT set_config('dva.admin_order_edit', $1, true)", [String(id)]);
      }
      const parcels = await this.repository.parcelReferences(client, id);
      const byId = new Map(parcels.map((parcel) => [parcel.orderParcelSeq, parcel]));
      const position = parcels.at(-1)?.parcelPosition ?? 0;
      for (const parcelId of input.removeParcelSeqs ?? [])
        if (!byId.has(parcelId))
          throw new ApiException(404, 'NOT_FOUND', '해당 주문의 상세를 찾을 수 없습니다.');
      for (const change of input.parcels ?? []) {
        const previous =
          change.orderParcelSeq === undefined ? undefined : byId.get(change.orderParcelSeq);
        if (change.orderParcelSeq !== undefined && !previous)
          throw new ApiException(404, 'NOT_FOUND', '해당 주문의 상세를 찾을 수 없습니다.');
        if (adminId === null && previous?.status === 'CANCELLED')
          throw new ApiException(409, 'INVALID_STATE', '취소된 주문 상세는 수정할 수 없습니다.');
        const pin = change.originPin === undefined ? previous?.originPin : change.originPin;
        if (pin && !(await this.repository.canUsePin(client, customer.customerSeq, pin)))
          throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
      }
      await this.repository.updateHeader(
        client,
        id,
        adminId === null ? input : { ...input, totalAmount: undefined },
      );
      for (const change of input.parcels ?? []) {
        if (change.orderParcelSeq !== undefined)
          await this.repository.updateParcel(client, id, change);
      }
      await this.repository.insertParcels(
        client,
        id,
        position + 1,
        orderDraft({
          parcels: input.parcels?.filter((change) => change.orderParcelSeq === undefined),
        }).parcels,
      );
      for (const parcelId of input.removeParcelSeqs ?? []) {
        if (byId.get(parcelId)!.status === 'CANCELLED') continue;
        await this.repository.cancelParcel(client, parcelId);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            actorType: 'ADMIN',
            targetId: parcelId,
            targetType: 'ORDER_PARCEL',
            action: 'ORDER_PARCEL_CANCELLED',
            requestId,
          },
          client,
        );
      }
      if (adminId !== null) {
        const active = (await this.repository.lockParcels(client, id)).filter(
          (parcel) => parcel.status === 'ACTIVE',
        );
        const sum = active.reduce((amount, parcel) => amount + (parcel.notifiedPrice ?? 0), 0);
        if (
          sum > 2147483647 ||
          (order.status !== 'COLLECTING' && active.some((parcel) => parcel.notifiedPrice === null))
        )
          throw new ApiException(
            422,
            'VALIDATION_FAILED',
            '상세별 배송비와 합계 범위를 확인해 주세요.',
          );
        const amount = await this.repository.recalculateAmount(client, id);
        if (input.totalAmount !== undefined && input.totalAmount !== amount)
          throw new ApiException(
            422,
            'VALIDATION_FAILED',
            '주문 총액은 미취소 상세의 배송비 합계와 일치해야 합니다.',
          );
        if (order.status === 'notPaid' && order.totalAmount !== amount)
          await this.payments.replaceRequest(client, id);
        if (order.totalAmount !== amount)
          await this.audit.recordSuccess(
            {
              actorId: adminId,
              actorType: 'ADMIN',
              targetId: id,
              targetType: 'ORDER',
              action: 'ORDER_AMOUNT_CHANGED',
              requestId,
              metadata: { amountBefore: order.totalAmount, amountAfter: amount },
            },
            client,
          );
      }
      if (call && call.orderSeq === null) await this.calls.attachOrder(client, callId!, id);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: adminId === null ? 'AI' : 'ADMIN',
          targetId: id,
          action: 'ORDER_UPDATED',
          targetType: 'ORDER',
          requestId,
        },
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

  async cancel(
    adminId: number | null,
    id: number,
    requestId: string,
    callSessionHeader?: string,
    orderParcelSeqs?: number[],
  ): Promise<void> {
    const callId = this.callId(adminId, callSessionHeader);
    await this.database.transaction(async (client) => {
      const customerId = await this.readCustomer(client, adminId, callId, id);
      const order = await this.repository.lockOrder(client, id);
      if (!order || (customerId !== null && order.customerSeq !== customerId))
        throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      const parcels = await this.repository.lockParcels(client, id);
      const selectedIds = orderParcelSeqs === undefined ? null : new Set(orderParcelSeqs);
      const selected = selectedIds
        ? parcels.filter((parcel) => selectedIds.has(parcel.orderParcelSeq))
        : parcels;
      if (selectedIds && selected.length !== selectedIds.size)
        throw new ApiException(404, 'NOT_FOUND', '해당 주문의 상세를 찾을 수 없습니다.');
      const targets = selected.filter((parcel) => parcel.status === 'ACTIVE');
      if (selectedIds && targets.length === 0) return;
      if (order.status === 'CANCELLED')
        throw new ApiException(409, 'INVALID_STATE', '이미 취소된 주문입니다.');
      if (order.status !== 'COLLECTING' && order.status !== 'notPaid')
        throw new ApiException(409, 'INVALID_STATE', '현재 주문 상태에서는 취소할 수 없습니다.');

      if (await this.payments.isApproving(client, id))
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '결제 승인 처리 중에는 취소할 수 없습니다.',
        );
      const parcelIds = targets.map((parcel) => parcel.orderParcelSeq);
      const shipments = await this.repository.lockShipments(client, parcelIds);
      if (
        (order.status === 'COLLECTING' && shipments.length > 0) ||
        (order.status === 'notPaid' && (parcels.length === 0 || shipments.length > 0))
      )
        throw new ApiException(
          409,
          'INVALID_STATE',
          '결제 전 상태가 확인된 주문만 취소할 수 있습니다.',
        );

      await this.repository.cancelShipments(client, parcelIds, adminId);
      for (const parcel of selectedIds ? targets : []) {
        await this.repository.cancelParcel(client, parcel.orderParcelSeq);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            actorType: adminId === null ? 'AI' : 'ADMIN',
            targetId: parcel.orderParcelSeq,
            targetType: 'ORDER_PARCEL',
            action: 'ORDER_PARCEL_CANCELLED',
            requestId,
          },
          client,
        );
      }
      if (
        !selectedIds ||
        parcels.every(
          (parcel) => parcel.status === 'CANCELLED' || selectedIds.has(parcel.orderParcelSeq),
        )
      ) {
        await this.repository.cancel(client, id);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            actorType: adminId === null ? 'AI' : 'ADMIN',
            targetId: id,
            targetType: 'ORDER',
            action: 'ORDER_CANCELLED',
            requestId,
          },
          client,
        );
      }
      const amountAfter = await this.repository.recalculateAmount(client, id);
      if (order.status === 'notPaid') await this.payments.replaceRequest(client, id);
      if (targets.length > 0)
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            actorType: adminId === null ? 'AI' : 'ADMIN',
            targetId: id,
            targetType: 'ORDER',
            action: 'ORDER_AMOUNT_CHANGED',
            requestId,
            metadata: { amountBefore: order.totalAmount, amountAfter, orderParcelSeqs: parcelIds },
          },
          client,
        );
    });
  }

  async submit(
    adminId: number | null,
    id: number,
    input: SubmitOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<SubmittedOrderDto> {
    const callId = this.callId(adminId, callSessionHeader);
    const prepared = await this.write(async (client) => {
      const customerId = await this.readCustomer(client, adminId, callId, id);
      const order = await this.repository.lockOrder(client, id);
      if (!order || (customerId !== null && order.customerSeq !== customerId))
        throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      if (order.status !== 'COLLECTING') {
        if (order.status === 'CANCELLED')
          throw new ApiException(409, 'INVALID_STATE', '취소된 주문입니다.');
        if (order.status === 'SUBMITTING' && (await this.submissions.markStale(client, id))) {
          await this.audit.recordSuccess(
            {
              actorId: null,
              actorType: 'SYSTEM',
              targetId: id,
              targetType: 'ORDER',
              action: 'ORDER_SUBMISSION_FAILED',
              requestId,
            },
            client,
          );
          return { status: 'SUBMISSION_FAILED' as const };
        }
        return { status: order.status };
      }
      const call = callId === null ? undefined : await this.repository.call(client, callId);
      if (call && (call.endedAt !== null || (call.orderSeq !== null && call.orderSeq !== id)))
        throw new ApiException(409, 'INVALID_STATE', '진행 중인 연결 통화가 필요합니다.');
      if (order.customerSeq === null)
        throw new ApiException(403, 'FORBIDDEN', '주문 고객이 필요합니다.');
      if (order.version !== input.expectedVersion)
        throw new ApiException(409, 'VERSION_CONFLICT', '최신 주문 내용을 다시 확인해 주세요.');
      await this.customers.resolveForOrder(
        client,
        { customerSeq: order.customerSeq },
        adminId,
        requestId,
      );
      const payload = await this.prepareSubmission(
        client,
        id,
        order.customerSeq,
        adminId,
        requestId,
      );
      if (call && call.orderSeq === null) await this.calls.attachOrder(client, callId!, id);
      return { status: payload ? ('PAID' as const) : ('notPaid' as const) };
    });
    return prepared.status === 'PAID' ? this.submitPaidOrder(id, requestId) : prepared;
  }

  async submitPaidOrder(
    id: number,
    requestId: string,
    adminId: number | null = null,
    retry = false,
  ): Promise<SubmittedOrderDto> {
    const prepared = await this.write(async (client) => {
      const order = await this.repository.lockOrder(client, id);
      if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      if (order.status !== 'PAID' && !(retry && order.status === 'SUBMISSION_FAILED'))
        return { status: order.status };
      const snapshot = (await this.repository.detail(client, id, null))!;
      // Payment fixes pickup at paid_at + 1 hour. Retries preserve that snapshot.
      const payload = dverPayload(snapshot, 0);
      assertOrderAmount(snapshot);
      this.dver.ensureConfigured();
      await this.submissions.start(client, id);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: adminId === null ? 'SYSTEM' : 'ADMIN',
          targetId: id,
          targetType: 'ORDER',
          action: retry ? 'ORDER_RESUBMISSION_STARTED' : 'ORDER_SUBMISSION_STARTED',
          requestId,
        },
        client,
      );
      return { payload };
    });
    if ('status' in prepared) return { status: prepared.status! };
    return this.finishSubmission(id, requestId, prepared.payload);
  }

  async retry(id: number, adminId: number, requestId: string) {
    const order = await this.database.transaction((client) =>
      this.repository.lockOrder(client, id),
    );
    if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
    if (!['SUBMISSION_FAILED', 'SUBMITTING', 'ACCEPTED'].includes(order.status))
      throw new ApiException(409, 'INVALID_STATE', '디버 접수 실패 주문만 재접수할 수 있습니다.');
    return this.submitPaidOrder(id, requestId, adminId, true);
  }

  private async prepareSubmission(
    client: PoolClient,
    id: number,
    customerId: number,
    adminId: number | null,
    requestId: string,
  ) {
    const snapshot = (await this.repository.detail(client, id, null))!;
    assertOrderSubmissionReady(snapshot, Date.now(), false);
    assertOrderAmount(snapshot);
    const policy = await this.payments.eligibility(client, customerId);
    if (
      (snapshot.paymentMethodType === 'credit' && !policy.monthly) ||
      (snapshot.paymentMethodType === 'groupBilling' && !policy.group)
    )
      throw new ApiException(403, 'FORBIDDEN', '선택한 결제 방식의 사용 자격이 없습니다.');
    if (await this.submissions.hasShipments(client, id))
      throw new ApiException(409, 'INVALID_STATE', '이미 배송 정보가 생성된 주문입니다.');
    for (const parcel of snapshot.parcels) {
      if (parcel.status === 'CANCELLED') continue;
      if (
        parcel.originPin &&
        !(await this.repository.canUsePin(client, customerId, parcel.originPin))
      )
        throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
    }
    if (snapshot.paymentMethodType === 'billing') {
      await this.payments.waitForPayment(client, id);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: adminId === null ? 'AI' : 'ADMIN',
          targetId: id,
          targetType: 'ORDER',
          action: 'ORDER_PAYMENT_PENDING',
          requestId,
          metadata: { amountAfter: snapshot.totalAmount },
        },
        client,
      );
      return undefined;
    }
    this.dver.ensureConfigured();
    await this.payments.billed(client, id, policy.organizationSeq, policy.departmentSeq, requestId);
    await this.audit.recordSuccess(
      {
        actorId: null,
        actorType: 'SYSTEM',
        targetId: id,
        targetType: 'ORDER',
        action: 'ORDER_PAYMENT_COMPLETED',
        requestId,
        metadata: { amountAfter: snapshot.totalAmount },
      },
      client,
    );
    return true;
  }

  private async finishSubmission(
    id: number,
    requestId: string,
    payload: ReturnType<typeof dverPayload>,
  ): Promise<SubmittedOrderDto> {
    const event = {
      actorId: null,
      actorType: 'SYSTEM' as const,
      targetId: id,
      targetType: 'ORDER',
      requestId,
    };
    // SUBMITTING을 COMMIT한 요청만 전송하며 이 구간에는 DB 트랜잭션이 없다.
    let result: DverResult;
    try {
      result = await this.dver.submit(payload);
    } catch {
      result = { status: 'SUBMISSION_FAILED' };
    }
    try {
      await this.database.transaction(async (client) => {
        await this.submissions.finish(client, id, result);
        await this.audit.recordSuccess(
          {
            ...event,
            action:
              result.status === 'ACCEPTED'
                ? 'ORDER_SUBMISSION_ACCEPTED'
                : 'ORDER_SUBMISSION_FAILED',
          },
          client,
        );
      });
      this.logger.log({
        event: 'order_submission_result',
        orderSeq: id,
        requestId,
        outcome: result.status,
      });
      return { status: result.status };
    } catch {
      this.logger.error({ event: 'order_submission_result_save_failed', orderSeq: id, requestId });
      // 외부 접수가 성공했을 수 있다. 저장 실패 후에도 같은 주문을 다시 전송하지 않는다.
      return { status: 'SUBMITTING' };
    }
  }
}
