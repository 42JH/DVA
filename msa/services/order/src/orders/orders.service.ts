import { CreateManualOrderDto, ManualOrderResultDto } from './dto/manual-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto, OrderResultDto } from './dto/order-response.dto';
import { NoOrderResultDto } from './dto/no-order-result.dto';
import { callerPhone } from '../common/caller-phone';
import { OrderSubmissionService } from './order-submission.service';
import { SubmitOrderDto, SubmittedOrderDto } from './dto/submit-order.dto';
import type { OrderStatus } from './orders.types';
import { assertOrderUpdate } from './order-update.validation';
import { UpdateOrderDto } from './dto/update-order.dto';
import { orderDraft, hasOrderData, ORDER_ADDRESS_FIELDS } from './order-draft';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import type { DraftWriteEvent } from '@dva/events/parcel-draft-write.cjs';
import {
  requestOrderCancellation,
  OrderCancellationError,
} from '@dva/events/order-cancellation.cjs';
import { requestReferences, requestOrderOrganization } from '@dva/events/call-read-references.cjs';
import { requestDraftCallReferences } from '@dva/events/parcel-drafts.cjs';
import { readCallbackUrl } from '@dva/events/read-scope.cjs';
import { requestAdminOrderRead, type AdminOrderReadEvent } from '@dva/events/order-read.cjs';
import { incompleteDraftIds } from './parcel-draft-reads';
import { OrderShipmentCheckClient } from './order-shipment-check.client';
import { AuditService } from '../audit/audit.service';
import { writeOrder } from './order-write';
import { OrderDeletionCheckClient } from './order-deletion-check.client';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { isISO8601 } from 'class-validator';
import {
  requestOrderRead,
  OrderReadError,
  type OrderReadCommand,
} from '@dva/events/order-read.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { createValidationPipe } from '../common/http/validation.pipe';
import { AdminOrderListQueryDto } from './dto/admin-order-list.dto';
import { OrderAddressHistoryQueryDto } from './dto/order-address-history.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { OrdersRepository } from './orders.repository';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
    private readonly deletionCheck: OrderDeletionCheckClient,
    private readonly shipmentCheck: OrderShipmentCheckClient,
    private readonly writeScope: ParcelDraftWriteScope,
    private readonly submission: OrderSubmissionService,
    private readonly payments: PaymentsService,
  ) {}

  async create(
    adminId: number | null,
    key: string,
    input: CreateOrderDto,
    requestId: string,
    header?: string,
  ): Promise<CreatedOrderDto | OrderResultDto | NoOrderResultDto> {
    return this.createOrder(adminId, key, input, requestId, header);
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
    header?: string,
    submitManual = false,
  ): Promise<CreatedOrderDto | OrderResultDto | NoOrderResultDto> {
    const callSessionSeq = this.creationHeader(adminId, input, header);
    const prepared = (await this.writeScope.request({
      operation: submitManual ? 'ManualOrderCreated' : 'OrderCreated',
      id: null,
      key,
      adminId,
      callSessionSeq,
      input: { ...input },
      requestId,
    })) as unknown as {
      result: CreatedOrderDto | OrderResultDto | NoOrderResultDto;
      submit: boolean;
    };
    if (
      prepared.result.orderSeq === null ||
      (!prepared.submit && (prepared.result as OrderResultDto).status !== 'notPaid')
    )
      return prepared.result;
    if (prepared.submit) await this.submission.submitPaidOrder(prepared.result.orderSeq, requestId);
    else await this.payments.forOrder(prepared.result.orderSeq, requestId);
    try {
      return await this.database.transaction((client) =>
        this.repository.result(
          client,
          prepared.result.orderSeq!,
          (prepared.result as OrderResultDto).callSessionSeq,
        ),
      );
    } catch {
      return prepared.result;
    }
  }

  executeCreation(event: DraftWriteEvent) {
    return this.writeScope.run(event, async () => {
      const command = event.payload.command;
      const submitManual = command.operation === 'ManualOrderCreated';
      const input = (await createValidationPipe().transform(command.input, {
        type: 'body',
        metatype: submitManual ? CreateManualOrderDto : CreateOrderDto,
      })) as CreateOrderDto;
      const headerId = this.creationHeader(
        command.adminId,
        input,
        command.callSessionSeq === null ? undefined : String(command.callSessionSeq),
      );
      const draft = orderDraft(input);
      const adminId = command.adminId,
        key = command.key!,
        requestId = command.requestId;
      return this.writeScope.transaction(async (client) => {
        if (!(await this.repository.lockCreation(client, key)))
          throw new ApiException(
            409,
            'REQUEST_IN_PROGRESS',
            '같은 주문 생성 요청을 처리 중입니다.',
          );
        const callId = input.call ? await this.writeScope.ensureCall(input.call) : headerId;
        if (input.call && headerId !== null && headerId !== callId)
          throw new ApiException(
            409,
            'INVALID_STATE',
            '본문 세션과 call_session_seq가 일치하지 않습니다.',
          );
        await this.writeScope.recoverCreation(client, key, callId);
        const previous = await this.repository.findCreation(client, key);
        if (previous) {
          if (
            !(adminId === null
              ? callId !== null &&
                (await this.writeScope.creationAllowed(callId, previous.orderSeq))
              : previous.adminId === adminId &&
                (callId === null ||
                  (await this.writeScope.creationAllowed(callId, previous.orderSeq))))
          )
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
            return {
              result: { orderSeq: previous.orderSeq, version: previous.version },
              submit: false,
            };
          await this.submission.recoverStale(client, previous.orderSeq, requestId);
          return {
            result: await this.repository.result(client, previous.orderSeq, callId),
            submit: false,
          };
        }
        const empty = await this.repository.emptyResult(client, key);
        if (empty) {
          if (empty.callSessionSeq !== callId || empty.actorAdminUserSeq !== adminId)
            throw new ApiException(403, 'FORBIDDEN', '이 요청 키의 통화에 접근할 수 없습니다.');
          return { result: new NoOrderResultDto(empty.callSessionSeq), submit: false };
        }
        const call = callId === null ? undefined : await this.writeScope.call(callId);
        if (callId !== null && !call)
          throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
        if (call?.enabled)
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
            ? await this.writeScope.prepareOrderCustomer(client, draft)
            : await this.writeScope.customerByPhone(call!.callerPhoneNumber!);
        if (
          call?.callerPhoneNumber &&
          customer &&
          callerPhone(call.callerPhoneNumber) !== customer.phone
        )
          throw new ApiException(
            403,
            'FORBIDDEN',
            '통화 발신번호와 주문 고객이 일치하지 않습니다.',
          );
        const customerId = customer?.customerSeq ?? null;
        for (const parcel of draft.parcels) {
          if (parcel.originPin?.scope === 'COMPANY')
            throw new ApiException(
              400,
              'INVALID_REQUEST',
              '기업 배송지는 PIN 대신 주소로 전달해 주세요.',
            );
          if (
            parcel.originPin &&
            (customerId === null ||
              !(await this.writeScope.canUsePin(customerId, parcel.originPin.pinSeq)))
          )
            throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
        }
        if (input.call && input.outcome !== 'COMPLETE' && !hasOrderData(draft)) {
          await this.writeScope.linkCreatedOrder(callId!, null, customerId);
          await this.repository.saveEmptyResult(client, key, callId!, adminId);
          return { result: new NoOrderResultDto(callId!), submit: false };
        }
        const result = await this.repository.insert(
          client,
          draft,
          customerId,
          key,
          callId !== null ? 'AI' : 'ADMIN',
          adminId,
        );
        if (callId !== null)
          await this.writeScope.linkCreatedOrder(callId, result.orderSeq, customerId);
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
        if (!input.call && !submitManual) return { result, submit: false };
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
        return {
          result: await this.repository.result(client, result.orderSeq, callId),
          submit: payload === true,
        };
      });
    });
  }

  private creationHeader(
    adminId: number | null,
    input: CreateOrderDto,
    callSessionHeader?: string,
  ) {
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
    return this.callId(input.call ? 0 : adminId, callSessionHeader);
  }

  intakeResult(id: number, callId: number) {
    return this.repository.result(this.database.pool, id, callId);
  }

  async delete(id: number | number[], adminId: number, requestId: string): Promise<void> {
    const ids = (Array.isArray(id) ? [...id] : [id]).sort((a, b) => a - b);
    await writeOrder(this.database, async (client) => {
      for (const id of ids) {
        const order = await this.repository.lockOrder(client, id);
        if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
        if (
          !['COLLECTING', 'CANCELLED', 'ACCEPTED'].includes(order.status) ||
          (await this.repository.paymentDeletionBlocked(client, id)) ||
          (await this.deletionCheck.blocked(id))
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

  async cancel(
    adminId: number | null,
    id: number,
    requestId: string,
    callSessionHeader?: string,
    orderParcelSeqs?: number[],
  ): Promise<void> {
    const callId = this.callId(adminId, callSessionHeader);
    if (adminId !== null) return this.cancelScoped(adminId, id, requestId, orderParcelSeqs, null);
    try {
      await requestOrderCancellation(
        this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/order-cancellation',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'OrderCancellationRequested',
          payload: {
            command: {
              id,
              callSessionSeq: callId!,
              requestId,
              orderParcelSeqs: orderParcelSeqs ?? null,
            },
          },
        },
      );
    } catch (error) {
      if (error instanceof OrderCancellationError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  async cancelScoped(
    adminId: number | null,
    id: number,
    requestId: string,
    orderParcelSeqs: number[] | undefined,
    customerId: number | null,
    unpaidOnly = false,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const order = await this.repository.lockOrder(client, id);
      const ownsOrder = customerId === null || order?.customerSeq === customerId;
      if (ownsOrder && (await this.repository.hasMigratedDrafts(client, id)))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '미완료 배송 초안으로 이관된 주문입니다. 배송 초안 API에서 보완해 주세요.',
        );
      if (!order || !ownsOrder)
        throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      if (unpaidOnly && order.status !== 'notPaid')
        throw new ApiException(
          409,
          'INVALID_STATE',
          '신규 통화에서 결제 대기 주문만 취소할 수 있습니다.',
        );
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

      if (await this.repository.isApproving(client, id))
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '결제 승인 처리 중에는 취소할 수 없습니다.',
        );
      const parcelIds = targets.map((parcel) => parcel.orderParcelSeq);
      const hasShipments = await this.shipmentCheck.blocked(parcelIds);
      if (
        (order.status === 'COLLECTING' && hasShipments) ||
        (order.status === 'notPaid' && (parcels.length === 0 || hasShipments))
      )
        throw new ApiException(
          409,
          'INVALID_STATE',
          '결제 전 상태가 확인된 주문만 취소할 수 있습니다.',
        );

      // Every shipment blocks cancellation above; the source shipment UPDATE has no targets.
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
      if (order.status === 'notPaid') await this.repository.replaceRequest(client, id);
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

  private assertDateRange(query: { from?: string; to?: string }): void {
    const zoned = (value: string) =>
      isISO8601(value, { strict: true, strictSeparator: true }) &&
      /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value));
    if (
      (query.from !== undefined && !zoned(query.from)) ||
      (query.to !== undefined && !zoned(query.to)) ||
      (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '조회 기간을 확인해 주세요. from은 to보다 빨라야 합니다.',
      );
  }

  async adminList(query: AdminOrderListQueryDto) {
    this.assertDateRange(query);
    try {
      const result = await requestAdminOrderRead(
        this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/admin-order-read',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'AdminOrdersReadRequested',
          payload: {
            query: { ...query },
            orderAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
          },
        },
      );
      return Object.assign(Object.create(ListResponse.prototype) as ListResponse<unknown>, result);
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  async executeAdmin(event: AdminOrderReadEvent) {
    const query = (await createValidationPipe().transform(event.payload.query, {
      metatype: AdminOrderListQueryDto,
      type: 'query',
    })) as AdminOrderListQueryDto;
    this.assertDateRange(query);
    const token = this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
    const customerOrigin = this.config.get('CUSTOMER_URL', { infer: true }),
      consultationOrigin = this.config.get('CONSULTATION_URL', { infer: true });
    const customerUrl = (path: string) =>
      readCallbackUrl(customerOrigin, path, event.payload.customerAddress ?? null);
    const consultationUrl = readCallbackUrl(
      consultationOrigin,
      '/internal/order-draft-call-references',
      event.payload.consultationAddress ?? null,
    );
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SELECT 1');
      const organization =
        query.organizationSeq === undefined
          ? null
          : await requestOrderOrganization(
              customerUrl('/internal/call-read-references/order-organization'),
              token,
              query.organizationSeq,
              event.eventId,
            );
      const draftIds = await incompleteDraftIds(
        client,
        query,
        organization?.customer_seqs ?? null,
        (input) => requestDraftCallReferences(consultationUrl, token, input, event.eventId),
      );
      const rows = await this.repository.adminList(
        client,
        query,
        organization?.customer_seqs ?? null,
        draftIds,
      );
      const customerIds = [
        ...new Set(rows.rows.flatMap((row) => (row.customerSeq === null ? [] : [row.customerSeq]))),
      ];
      const customers = new Map(
        (customerIds.length
          ? await requestReferences(
              'customer',
              customerUrl('/internal/call-read-references/for-orders'),
              token,
              customerIds,
              'order',
              event.eventId,
            )
          : []
        ).map((row) => [row.customer_seq, row]),
      );
      const page = new ListResponse(
        {
          ...rows,
          rows: rows.rows.map((row) => ({
            ...row,
            customerSeq:
              row.customerSeq === null
                ? null
                : (customers.get(row.customerSeq)?.customer_seq ?? null),
            organizationName:
              row.customerSeq === null
                ? null
                : (customers.get(row.customerSeq)?.organization_name ?? null),
          })),
        },
        query.limit,
      );
      const counts = await this.repository.adminStatusCounts(
        client,
        query,
        organization?.customer_seqs ?? null,
      );
      return Object.assign(page, {
        statusCounts: { ...counts, all: counts.all + draftIds.length, incomplete: draftIds.length },
      });
    });
  }

  async list(adminId: number | null, query: OrderQueryDto, header?: string) {
    const callId = this.callId(adminId, header);
    this.assertDateRange(query);
    if (adminId !== null)
      return this.execute(
        { operation: 'OrdersListed', id: null, callSessionSeq: callId, query: { ...query } },
        null,
      );
    return this.scoped({
      operation: 'OrdersListed',
      id: null,
      callSessionSeq: callId,
      query: { ...query },
    });
  }

  async detail(adminId: number | null, id: number, header?: string) {
    const callId = this.callId(adminId, header);
    const command: OrderReadCommand = {
      operation: 'OrderDetailRead',
      id,
      callSessionSeq: callId,
      query: {},
    };
    return adminId === null ? this.scoped(command) : this.execute(command, null);
  }

  async addressHistory(
    adminId: number | null,
    id: number,
    query: OrderAddressHistoryQueryDto,
    header?: string,
  ) {
    const callId = this.callId(adminId, header);
    this.assertDateRange(query);
    return this.scoped({
      operation: 'OrderAddressesListed',
      id,
      callSessionSeq: adminId === null ? callId : null,
      query: { ...query },
    });
  }

  private async scoped(command: OrderReadCommand) {
    try {
      const result = await requestOrderRead(
        this.config.get(command.callSessionSeq === null ? 'CUSTOMER_URL' : 'CONSULTATION_URL', {
          infer: true,
        }) + '/internal/order-read',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'OrderReadRequested',
          payload: { command },
        },
      );
      return command.operation === 'OrderDetailRead'
        ? result
        : Object.assign(Object.create(ListResponse.prototype) as ListResponse<unknown>, result);
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  async execute(command: OrderReadCommand, customerId: number | null): Promise<unknown> {
    const type =
      command.operation === 'OrderAddressesListed' ? OrderAddressHistoryQueryDto : OrderQueryDto;
    const query = (await createValidationPipe().transform(command.query, {
      metatype: type,
      type: 'query',
    })) as OrderQueryDto & OrderAddressHistoryQueryDto;
    this.assertDateRange(query);
    if (
      command.operation === 'OrdersListed' &&
      customerId !== null &&
      query.customerSeq !== undefined &&
      query.customerSeq !== customerId
    )
      throw new ApiException(403, 'FORBIDDEN', '다른 고객의 주문은 조회할 수 없습니다.');
    if (command.operation === 'OrderAddressesListed' && customerId !== command.id)
      throw new ApiException(403, 'FORBIDDEN', '다른 고객의 이전 주문 주소는 조회할 수 없습니다.');
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Establish one local snapshot before repository calls, including concurrent parcel edits.
      await client.query('SELECT 1');
      switch (command.operation) {
        case 'OrdersListed':
          return new ListResponse(
            await this.repository.list(client, query, customerId ?? query.customerSeq ?? null),
            query.limit,
          );
        case 'OrderAddressesListed':
          return new ListResponse(
            await this.repository.addressHistory(client, command.id!, query),
            query.limit,
          );
        case 'OrderDetailRead': {
          const order = await this.repository.detail(client, command.id!, customerId);
          if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
          return order;
        }
      }
    });
  }
  update(
    adminId: number | null,
    id: number,
    input: UpdateOrderDto,
    requestId: string,
    header?: string,
  ) {
    assertOrderUpdate(input);
    if (adminId === null && input.removeParcelSeqs !== undefined)
      throw new ApiException(403, 'FORBIDDEN', '배송상세 제거는 관리자만 할 수 있습니다.');
    const callSessionSeq = this.callId(adminId, header);
    return this.writeScope.request({
      operation: 'OrderUpdated',
      id,
      adminId,
      callSessionSeq,
      input: { ...input },
      requestId,
    });
  }
  executeUpdate(event: DraftWriteEvent) {
    return this.writeScope.run(event, async () => {
      const command = event.payload.command;
      const input: unknown = await createValidationPipe().transform(command.input, {
        type: 'body',
        metatype: UpdateOrderDto,
      });
      const result = await this.updateLocal(
        command.adminId,
        command.id!,
        input as UpdateOrderDto,
        command.requestId,
        command.callSessionSeq === null ? undefined : String(command.callSessionSeq),
      );
      return { version: result.version };
    });
  }
  private async updateLocal(
    adminId: number | null,
    id: number,
    input: UpdateOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ) {
    assertOrderUpdate(input);
    if (adminId === null && input.removeParcelSeqs !== undefined)
      throw new ApiException(403, 'FORBIDDEN', '배송상세 제거는 관리자만 할 수 있습니다.');
    const callId = this.callId(adminId, callSessionHeader);
    return this.writeScope.transaction(async (client) => {
      const call = callId === null ? undefined : await this.writeScope.call(callId);
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
      const customer = await this.writeScope.orderCustomer(order.customerSeq);
      if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      if (!customer.active)
        throw new ApiException(403, 'FORBIDDEN', '주문에는 활성 고객이 필요합니다.');
      if (
        (adminId === null && !call?.callerPhoneNumber) ||
        (call?.callerPhoneNumber && call.callerPhoneNumber !== customer.phone)
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
        if (await this.repository.isApproving(client, id))
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
      const requestedPins = (input.parcels ?? []).flatMap((change) => {
        const previous =
          change.orderParcelSeq === undefined ? undefined : byId.get(change.orderParcelSeq);
        const pin = change.originPin === undefined ? previous?.originPin : change.originPin;
        return pin ? [pin] : [];
      });
      const usablePinIds = new Set<number>();
      for (const pinSeq of [
        ...new Set(
          requestedPins.filter((pin) => pin.scope === 'PERSONAL').map((pin) => pin.pinSeq),
        ),
      ].sort((a, b) => a - b))
        if (await this.writeScope.canUsePin(customer.customerSeq, pinSeq)) usablePinIds.add(pinSeq);
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
          await this.repository.replaceRequest(client, id);
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
      if (call && call.orderSeq === null)
        await this.writeScope.linkOrder(callId!, id, customer.customerSeq);
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
      return { version: (await this.repository.currentVersion(client, id)).version };
    });
  }
  async submit(
    adminId: number | null,
    id: number,
    input: SubmitOrderDto,
    requestId: string,
    header?: string,
  ): Promise<SubmittedOrderDto> {
    const callSessionSeq = this.callId(adminId, header);
    const result = await this.writeScope.request({
      operation: 'OrderSubmitted',
      id,
      adminId,
      callSessionSeq,
      input: { ...input },
      requestId,
    });
    const status = result.status as OrderStatus;
    if (status === 'notPaid') return (await this.payments.forOrder(id, requestId)) ?? { status };
    return status === 'PAID' ? this.submission.submitPaidOrder(id, requestId) : { status };
  }
  executeSubmission(event: DraftWriteEvent) {
    return this.writeScope.run(event, async () => {
      const command = event.payload.command;
      const input = (await createValidationPipe().transform(command.input, {
        type: 'body',
        metatype: SubmitOrderDto,
      })) as SubmitOrderDto;
      const result = await this.submitLocal(
        command.adminId,
        command.id!,
        input,
        command.requestId,
        command.callSessionSeq === null ? undefined : String(command.callSessionSeq),
      );
      return { status: result.status };
    });
  }
  private async submitLocal(
    adminId: number | null,
    id: number,
    input: SubmitOrderDto,
    requestId: string,
    callSessionHeader?: string,
  ): Promise<SubmittedOrderDto> {
    const callId = this.callId(adminId, callSessionHeader);
    const prepared = await this.writeScope.transaction(async (client) => {
      let customerId: number | null = null;
      if (adminId === null) {
        const call = await this.writeScope.call(callId!);
        if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
        if (call.endedAt !== null && call.orderSeq !== id)
          throw new ApiException(
            409,
            'INVALID_STATE',
            '종료된 통화는 기존 연결 주문만 사용할 수 있습니다.',
          );
        const customer =
          call.callerPhoneNumber === null
            ? null
            : await this.writeScope.customerByPhone(call.callerPhoneNumber);
        if (!customer)
          throw new ApiException(
            403,
            'FORBIDDEN',
            '통화 발신번호에 연결된 활성 고객이 필요합니다.',
          );
        customerId = customer.customerSeq;
      }
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
      const call = callId === null ? undefined : await this.writeScope.call(callId);
      if (call && (call.endedAt !== null || (call.orderSeq !== null && call.orderSeq !== id)))
        throw new ApiException(409, 'INVALID_STATE', '진행 중인 연결 통화가 필요합니다.');
      if (order.customerSeq === null)
        throw new ApiException(403, 'FORBIDDEN', '주문 고객이 필요합니다.');
      if (order.version !== input.expectedVersion)
        throw new ApiException(409, 'VERSION_CONFLICT', '최신 주문 내용을 다시 확인해 주세요.');
      const customer = await this.writeScope.orderCustomer(order.customerSeq);
      if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
      if (!customer.active)
        throw new ApiException(403, 'FORBIDDEN', '주문에는 활성 고객이 필요합니다.');
      const payload = await this.submission.prepareSubmission(
        client,
        id,
        order.customerSeq,
        adminId,
        requestId,
      );
      if (call && call.orderSeq === null)
        await this.writeScope.linkOrder(callId!, id, order.customerSeq);
      return { status: payload ? ('PAID' as const) : ('notPaid' as const) };
    });
    return prepared;
  }
}
