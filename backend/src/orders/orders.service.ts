import { Injectable } from '@nestjs/common';
import { OrderCardPaymentsService } from './order-card-payments.service';
import { OrderSubmissionService } from './order-submission.service';
import { writeOrder } from './order-write';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CustomersService } from '../customers/customers.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto, OrderResultDto } from './dto/order-response.dto';
import { NoOrderResultDto } from './dto/no-order-result.dto';
import { hasOrderData, orderDraft, ORDER_ADDRESS_FIELDS } from './order-draft';
import { OrdersRepository } from './orders.repository';
import { orderCallId, readOrderCustomer } from './order-access';
import { UpdateOrderDto, UpdatedOrderDto } from './dto/update-order.dto';
import { assertOrderUpdate } from './order-update.validation';
import { SubmitOrderDto, SubmittedOrderDto } from './dto/submit-order.dto';
import { callerPhone } from '../common/caller-phone';
import { CreateManualOrderDto, ManualOrderResultDto } from './dto/manual-order.dto';
import { ConsultationsService } from '../consultations/consultations.service';
import { OrderPaymentsRepository } from './order-payments.repository';

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly calls: ConsultationsService,
    private readonly payments: OrderPaymentsRepository,
    private readonly submission: OrderSubmissionService,
    private readonly cardPayments: OrderCardPaymentsService,
  ) {}

  async delete(id: number | number[], adminId: number, requestId: string): Promise<void> {
    const ids = (Array.isArray(id) ? [...id] : [id]).sort((a, b) => a - b);
    await writeOrder(this.database, async (client) => {
      for (const id of ids) {
        const order = await this.repository.lockOrder(client, id);
        if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
        if (
          !['COLLECTING', 'CANCELLED', 'ACCEPTED'].includes(order.status) ||
          (await this.repository.deletionBlocked(client, id))
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '진행 중인 통화·결제·접수 처리를 마친 뒤 삭제해 주세요.',
          );
        await this.repository.softDelete(client, id);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            action: 'ORDER_DELETED',
            targetType: 'ORDER',
            targetId: id,
            requestId,
          },
          client,
        );
      }
    });
  }

  async create(
    adminId: number | null,
    key: string,
    input: CreateOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<CreatedOrderDto | OrderResultDto | NoOrderResultDto> {
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
  ): Promise<CreatedOrderDto | OrderResultDto | NoOrderResultDto> {
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
    const headerId = orderCallId(input.call ? 0 : adminId, callSessionHeader);
    const draft = orderDraft(input);
    const prepared = await writeOrder(this.database, async (client) => {
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
        if (previous.deleted)
          throw new ApiException(
            409,
            'INVALID_STATE',
            '삭제되었거나 보관 기간이 지난 주문의 요청 키입니다.',
          );
        if (submitManual && previous.creationSource !== 'ADMIN')
          throw new ApiException(409, 'INVALID_STATE', '관리자 수기 주문의 요청 키가 아닙니다.');
        if (!input.call && !submitManual)
          return { result: { orderSeq: previous.orderSeq, version: previous.version } };
        await this.submission.recoverStale(client, previous.orderSeq, requestId);
        return { result: await this.repository.result(client, previous.orderSeq, callId) };
      }
      const empty = await this.repository.emptyResult(client, key);
      if (empty) {
        if (empty.callSessionSeq !== callId || empty.actorAdminUserSeq !== adminId)
          throw new ApiException(403, 'FORBIDDEN', '이 요청 키의 통화에 접근할 수 없습니다.');
        return { result: new NoOrderResultDto(empty.callSessionSeq) };
      }
      const call = callId === null ? undefined : await this.repository.call(client, callId);
      if (callId !== null && !call)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (call?.orderIntakeEnabled)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '신규 통화는 parcel-drafts와 order-intake/complete API를 사용해 주세요.',
        );
      if (callId !== null && (await this.repository.hasEmptyResult(client, callId)))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '이미 주문 없는 통화 결과를 수신했습니다. 같은 요청 키를 사용해 주세요.',
        );
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
      if (callId !== null && customerId !== null)
        await this.calls.attachCustomer(client, callId, customerId);
      const usablePinIds =
        customerId === null
          ? new Set<number>()
          : await this.repository.usablePersonalPinIds(
              client,
              customerId,
              draft.parcels.flatMap((parcel) => (parcel.originPin ? [parcel.originPin] : [])),
            );
      for (const parcel of draft.parcels) {
        if (parcel.originPin?.scope === 'COMPANY')
          throw new ApiException(
            400,
            'INVALID_REQUEST',
            '기업 배송지는 PIN 대신 주소로 전달해 주세요.',
          );
        if (parcel.originPin && (customerId === null || !usablePinIds.has(parcel.originPin.pinSeq)))
          throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
      }
      if (input.call && input.outcome !== 'COMPLETE' && !hasOrderData(draft)) {
        await this.repository.saveEmptyResult(client, key, callId!, adminId);
        return { result: new NoOrderResultDto(callId!) };
      }
      const result = await this.repository.insert(
        client,
        draft,
        customerId,
        key,
        callId !== null ? 'AI' : 'ADMIN',
        adminId,
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
          ? await this.submission.prepareSubmission(
              client,
              result.orderSeq,
              customerId!,
              adminId,
              requestId,
            )
          : undefined;
      return { result: await this.repository.result(client, result.orderSeq, callId), payload };
    });
    if (
      prepared.result.orderSeq === null ||
      (!prepared.payload && (prepared.result as OrderResultDto).status !== 'notPaid')
    )
      return prepared.result;
    if (prepared.payload)
      await this.submission.submitPaidOrder(prepared.result.orderSeq, requestId);
    else await this.cardPayments.forOrder(prepared.result.orderSeq, requestId);
    try {
      return await this.database.transaction((client) =>
        this.repository.result(
          client,
          prepared.result.orderSeq!,
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
    const callId = orderCallId(adminId, callSessionHeader);
    return writeOrder(this.database, async (client) => {
      if (adminId === null && (await this.repository.isDraftCall(client, callId!)))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '신규 통화의 수정·취소는 배송 초안 API를 사용해 주세요.',
        );
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
      if (await this.repository.hasMigratedDrafts(client, id))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '미완료 배송 초안으로 이관된 주문입니다. 배송 초안 API에서 보완해 주세요.',
        );
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
      const usablePinIds = await this.repository.usablePersonalPinIds(
        client,
        customer.customerSeq,
        (input.parcels ?? []).flatMap((change) => {
          const previous =
            change.orderParcelSeq === undefined ? undefined : byId.get(change.orderParcelSeq);
          const pin = change.originPin === undefined ? previous?.originPin : change.originPin;
          return pin ? [pin] : [];
        }),
      );
      for (const change of input.parcels ?? []) {
        const previous =
          change.orderParcelSeq === undefined ? undefined : byId.get(change.orderParcelSeq);
        if (change.orderParcelSeq !== undefined && !previous)
          throw new ApiException(404, 'NOT_FOUND', '해당 주문의 상세를 찾을 수 없습니다.');
        if (adminId === null && previous?.status === 'CANCELLED')
          throw new ApiException(409, 'INVALID_STATE', '취소된 주문 상세는 수정할 수 없습니다.');
        const pin = change.originPin === undefined ? previous?.originPin : change.originPin;
        if (pin?.scope === 'COMPANY') {
          // Retired references identify saved history, never a newly selectable address.
          if (
            previous?.originPin?.scope !== 'COMPANY' ||
            previous.originPin.pinSeq !== pin.pinSeq ||
            ORDER_ADDRESS_FIELDS.some(
              (field) =>
                change.origin?.[field] !== undefined &&
                change.origin[field] !== previous.origin[field],
            )
          )
            throw new ApiException(
              400,
              'INVALID_REQUEST',
              '기존 기업 PIN 참조를 새로 지정하거나 주소 변경에 사용할 수 없습니다.',
            );
        } else if (pin && !usablePinIds.has(pin.pinSeq))
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

  async submit(
    adminId: number | null,
    id: number,
    input: SubmitOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<SubmittedOrderDto> {
    const callId = orderCallId(adminId, callSessionHeader);
    const prepared = await writeOrder(this.database, async (client) => {
      if (adminId === null && (await this.repository.isDraftCall(client, callId!)))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '신규 통화의 최종 확정은 order-intake/complete API를 사용해 주세요.',
        );
      const customerId = await readOrderCustomer(this.repository, client, adminId, callId, id);
      const order = await this.repository.lockOrder(client, id);
      if (await this.repository.hasMigratedDrafts(client, id))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '미완료 배송 초안으로 이관된 주문입니다. 배송 초안 API에서 보완해 주세요.',
        );
      if (!order || (customerId !== null && order.customerSeq !== customerId))
        throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      if (order.status !== 'COLLECTING') {
        if (order.status === 'CANCELLED')
          throw new ApiException(409, 'INVALID_STATE', '취소된 주문입니다.');
        if (order.status === 'SUBMITTING') {
          const recovered = await this.submission.recoverStale(client, id, requestId);
          if (recovered) return { status: recovered };
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
      const payload = await this.submission.prepareSubmission(
        client,
        id,
        order.customerSeq,
        adminId,
        requestId,
      );
      if (call && call.orderSeq === null) await this.calls.attachOrder(client, callId!, id);
      return { status: payload ? ('PAID' as const) : ('notPaid' as const) };
    });
    if (prepared.status === 'notPaid')
      return (await this.cardPayments.forOrder(id, requestId)) ?? prepared;
    return prepared.status === 'PAID' ? this.submission.submitPaidOrder(id, requestId) : prepared;
  }
}
