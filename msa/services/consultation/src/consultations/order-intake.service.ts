import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderReadError,
  requestOrderIntakeResult,
} from '@dva/events/order-read.cjs';
import { randomUUID } from 'node:crypto';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type {
  OrderIntakeResponseDto,
  ParcelConversionDto,
} from './dto/order-intake-response.dto';

type IntakeCall = Pick<
  OrderIntakeResponseDto,
  | 'intakeVersion'
  | 'endedAt'
  | 'completionReceivedAt'
  | 'finalizedAt'
  | 'errorCode'
> & {
  enabled: boolean;
  finalizationResult: {
    orderSeq: number | null;
    parcelMappings: ParcelConversionDto[];
  } | null;
};

@Injectable()
export class OrderIntakeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  detail(
    id: number,
    adminId: number | null,
    header?: string,
  ): Promise<OrderIntakeResponseDto> {
    return this.database.transaction(async (client) => {
      if (adminId === null && header !== undefined) {
        const headerId = Number(header);
        if (!/^[0-9]+$/.test(header) || headerId < 1 || headerId > 2147483647)
          throw new ApiException(
            400,
            'INVALID_REQUEST',
            '유효한 call_session_seq가 필요합니다.',
          );
        if (headerId !== id)
          throw new ApiException(
            403,
            'FORBIDDEN',
            '요청 경로와 통화 번호가 다릅니다.',
          );
      }
      const {
        rows: [call],
      } = await client.query<IntakeCall>(
        `SELECT order_intake_enabled AS enabled,order_intake_version AS "intakeVersion",
         ended_at AS "endedAt",order_completion_received_at AS "completionReceivedAt",
         order_finalized_at AS "finalizedAt",order_finalization_result AS "finalizationResult",
         order_finalization_error_code AS "errorCode"
         FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
          AND incoming_at>statement_timestamp()-interval '5 years' FOR SHARE`,
        [id],
      );
      if (!call)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (!call.enabled)
        throw new ApiException(409, 'INVALID_STATE', '이전 계약의 통화입니다.');

      const result = call.finalizationResult;
      const status = result
        ? result.orderSeq === null
          ? 'NO_ORDER'
          : 'FINALIZED'
        : !call.completionReceivedAt
          ? call.endedAt
            ? 'WAITING_AI'
            : 'COLLECTING'
          : !call.endedAt
            ? 'WAITING_PBX'
            : call.errorCode
              ? 'FAILED'
              : 'FINALIZING';
      const order = result?.orderSeq
        ? await this.orderResult(result.orderSeq, id)
        : null;
      return {
        callSessionSeq: id,
        intakeVersion: call.intakeVersion,
        status,
        endedAt: call.endedAt,
        completionReceivedAt: call.completionReceivedAt,
        finalizedAt: call.finalizedAt,
        errorCode: call.errorCode,
        orderSeq: result?.orderSeq ?? null,
        parcelMappings: result?.parcelMappings ?? [],
        order,
      };
    });
  }

  private async orderResult(orderSeq: number, callSessionSeq: number) {
    try {
      const order = this.config.get('ORDER_URL', { infer: true });
      if (!order) throw new Error('Order owner unavailable');
      return await requestOrderIntakeResult(
        order + '/internal/order-intake-result',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'consultation',
          eventType: 'OrderIntakeResultReadRequested',
          payload: { orderSeq, callSessionSeq },
        },
      );
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
}
