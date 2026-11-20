import { Injectable } from '@nestjs/common';
import { CoalescedPages } from '../common/coalesced-pages';
import { CoalescedReads } from '../common/coalesced-reads';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { AdminOrderListQueryDto } from './dto/admin-order-list.dto';
import {
  OrderAddressHistoryQueryDto,
  PreviousOrderAddressDto,
} from './dto/order-address-history.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { OrderSummaryDto } from './dto/order-response.dto';
import { ParcelDraftQueryDto } from './dto/parcel-draft.dto';
import { orderCallId, readOrderCustomer } from './order-access';
import { isZonedDate } from './order-draft';
import { OrdersRepository } from './orders.repository';
import { ParcelDraftsRepository } from './parcel-drafts.repository';

@Injectable()
export class OrderReadService {
  private readonly adminReads = new CoalescedPages<
    AdminOrderListQueryDto,
    Awaited<ReturnType<OrderReadService['readAdminList']>>
  >();
  private readonly orderReads = new CoalescedReads<ListResponse<OrderSummaryDto>>();
  private readonly orderPages = new CoalescedPages<OrderQueryDto, ListResponse<OrderSummaryDto>>();
  private readonly addressPages = new CoalescedPages<
    OrderAddressHistoryQueryDto,
    ListResponse<PreviousOrderAddressDto>
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly drafts: ParcelDraftsRepository,
  ) {}

  private assertDateRange(query: { from?: string; to?: string }): void {
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
  }

  async adminList(query: AdminOrderListQueryDto) {
    this.assertDateRange(query);
    return this.adminReads.read([], query, (page) => this.readAdminList(page));
  }

  private readAdminList(query: AdminOrderListQueryDto) {
    return this.database.readSnapshot(async (client) => {
      const filteredPage =
        query.statusGroup === undefined
          ? undefined
          : new ListResponse(await this.repository.adminList(client, query), query.limit);
      const statusCounts = await this.repository.adminStatusCounts(client, query);
      const incomplete = await this.drafts.countIncomplete(
        client,
        Object.assign(new ParcelDraftQueryDto(), {
          q: query.q,
          from: query.from,
          to: query.to,
          organizationSeq: query.organizationSeq,
        }),
      );
      const all = statusCounts.all + incomplete;
      const page =
        filteredPage ??
        new ListResponse(await this.repository.adminList(client, query, all), query.limit);
      return Object.assign(page, {
        statusCounts: { ...statusCounts, all, incomplete },
      });
    });
  }

  async list(adminId: number | null, query: OrderQueryDto, callSessionHeader?: string) {
    const callId = orderCallId(adminId, callSessionHeader);
    this.assertDateRange(query);
    if (adminId !== null) {
      if (callSessionHeader === undefined) {
        return this.orderPages.read([adminId], query, (page) =>
          this.readList(adminId, page, callId),
        );
      }
      return this.orderReads.read(JSON.stringify([adminId, query]), () =>
        this.readList(adminId, query, callId),
      );
    }
    return this.readList(adminId, query, callId);
  }

  private readList(adminId: number | null, query: OrderQueryDto, callId: number | null) {
    return this.database.readSnapshot(async (client) => {
      // 통화의 고객 범위와 주문 목록을 같은 시점의 데이터로 읽는다.
      const customerId = await readOrderCustomer(this.repository, client, adminId, callId);
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
    const callId = orderCallId(adminId, header);
    this.assertDateRange(query);
    if (adminId !== null && header === undefined) {
      return this.addressPages.read([adminId, customerId], query, (page) =>
        this.readAddressHistory(adminId, customerId, page, callId),
      );
    }
    return this.readAddressHistory(adminId, customerId, query, callId);
  }

  private readAddressHistory(
    adminId: number | null,
    customerId: number,
    query: OrderAddressHistoryQueryDto,
    callId: number | null,
  ) {
    return this.database.readSnapshot(async (client) => {
      const callerCustomer = await readOrderCustomer(this.repository, client, adminId, callId);
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

  async detail(adminId: number | null, id: number, callSessionHeader?: string) {
    const callId = orderCallId(adminId, callSessionHeader);
    return this.database.readSnapshot(async (client) => {
      const customerId = await readOrderCustomer(this.repository, client, adminId, callId, id);
      const order = await this.repository.detail(client, id, customerId);
      if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      return order;
    });
  }
}
