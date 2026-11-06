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
