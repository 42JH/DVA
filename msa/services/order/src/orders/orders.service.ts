import {
  requestOrderCancellation,
  OrderCancellationError,
} from '@dva/events/order-cancellation.cjs';
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

@Injectable()
export class OrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
    private readonly deletionCheck: OrderDeletionCheckClient,
    private readonly shipmentCheck: OrderShipmentCheckClient,
  ) {}

  async delete(id: number, adminId: number, requestId: string): Promise<void> {
    await writeOrder(this.database, async (client) => {
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
        { actorId: adminId, action: 'ORDER_DELETED', targetType: 'ORDER', targetId: id, requestId },
        client,
      );
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
  ): Promise<void> {
    await this.database.transaction(async (client) => {
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
    return new ListResponse(
      await this.repository.adminList(this.database.pool, query),
      query.limit,
    );
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
}
