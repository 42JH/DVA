import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { DeliveriesService } from '../deliveries/deliveries.service';
import { orderCallId, readOrderCustomer } from './order-access';
import { OrderPaymentsRepository } from './order-payments.repository';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class OrderCancellationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly payments: OrderPaymentsRepository,
    private readonly deliveries: DeliveriesService,
  ) {}

  async cancel(
    adminId: number | null,
    id: number,
    requestId: string,
    callSessionHeader?: string,
    orderParcelSeqs?: number[],
  ): Promise<void> {
    const callId = orderCallId(adminId, callSessionHeader);
    await this.database.transaction(async (client) => {
      const unpaidOnly = adminId === null && (await this.repository.isDraftCall(client, callId!));
      const customerId = await readOrderCustomer(
        this.repository,
        client,
        adminId,
        callId,
        id,
        unpaidOnly,
      );
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

      if (await this.payments.isApproving(client, id))
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '결제 승인 처리 중에는 취소할 수 없습니다.',
        );
      const parcelIds = targets.map((parcel) => parcel.orderParcelSeq);
      const shipments = await this.deliveries.lockShipments(client, parcelIds);
      if (
        (order.status === 'COLLECTING' && shipments.length > 0) ||
        (order.status === 'notPaid' && (parcels.length === 0 || shipments.length > 0))
      )
        throw new ApiException(
          409,
          'INVALID_STATE',
          '결제 전 상태가 확인된 주문만 취소할 수 있습니다.',
        );

      await this.deliveries.cancelShipments(client, parcelIds, adminId);
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
}
