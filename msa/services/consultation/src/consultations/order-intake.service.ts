import { Logger } from '@nestjs/common';
import {
  finalizationId,
  validateFinalization,
} from '@dva/events/order-intake-write.cjs';
import type { DraftWriteCommand } from '@dva/events/parcel-draft-write.cjs';
import { ParcelDraftWriteService } from '../customers/parcel-draft-write.service';
import { CompleteOrderIntakeDto } from './dto/complete-order-intake.dto';
import { sendEvent } from '@dva/events';
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
  private readonly logger = new Logger(OrderIntakeService.name);
  constructor(
    private readonly writes: ParcelDraftWriteService,
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async complete(id: number, input: CompleteOrderIntakeDto, requestId: string) {
    await this.request({
      operation: 'OrderIntakeSealed',
      id,
      adminId: null,
      callSessionSeq: id,
      input: { ...input },
      requestId,
    });
    await this.finalize(id, requestId);
    return this.detail(id, null);
  }
  async finalize(id: number, requestId: string): Promise<void> {
    let orderSeq: number | null = null;
    let originalRequestId = requestId;
    try {
      const result = await this.request({
        operation: 'OrderIntakeFinalized',
        id,
        adminId: null,
        callSessionSeq: id,
        input: {},
        requestId,
      });
      if (result.finalization) {
        validateFinalization(result.finalization);
        orderSeq = result.finalization.orderSeq;
        originalRequestId = result.finalization.requestId;
      }
    } catch (error) {
      const code =
        error instanceof ApiException
          ? (error.getResponse() as { code: string }).code
          : 'INTERNAL_ERROR';
      await this.database.pool.query(
        `UPDATE call_sessions SET order_finalization_attempted_at=clock_timestamp(),order_finalization_error_code=$2
        WHERE call_session_seq=$1 AND order_finalized_at IS NULL AND order_completion_received_at IS NOT NULL`,
        [id, code],
      );
      this.logger.error({
        event: 'order_intake_finalization_deferred',
        callSessionSeq: id,
        code,
        requestId,
      });
      return;
    }
    if (orderSeq !== null)
      try {
        await sendEvent(
          this.config.get('ORDER_URL', { infer: true }) +
            '/internal/parcel-draft-write/submit',
          this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
          {
            eventId: randomUUID(),
            source: 'consultation',
            eventType: 'OrderIntakeSubmissionRequested',
            payload: {
              callSessionSeq: id,
              orderSeq,
              requestId: originalRequestId,
            },
          },
        );
      } catch {
        this.logger.error({
          event: 'paid_order_submission_deferred',
          orderSeq,
          requestId,
        });
      }
  }
  async recoverPending() {
    const rows = (
      await this.database.pool.query<{
        id: number;
      }>(`SELECT call_session_seq AS id FROM call_sessions
      WHERE order_intake_enabled AND deleted_at IS NULL AND incoming_at>statement_timestamp()-interval '5 years'
       AND order_completion_received_at IS NOT NULL AND ended_at IS NOT NULL AND order_finalized_at IS NULL
       AND (order_finalization_attempted_at IS NULL OR order_finalization_attempted_at<=statement_timestamp()-interval '1 minute')
      ORDER BY order_finalization_attempted_at NULLS FIRST,call_session_seq LIMIT 20`)
    ).rows;
    await Promise.all(rows.map(({ id }) => this.finalize(id, randomUUID())));
  }
  private async request(command: DraftWriteCommand) {
    const result = await this.writes.execute({
      eventId:
        command.operation === 'OrderIntakeFinalized'
          ? finalizationId(command.id!)
          : randomUUID(),
      source: 'order',
      eventType: 'ParcelDraftWriteRequested',
      payload: { command, orderAddress: null },
    });
    return result.payload.data;
  }

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
