import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CallDashboardMetricsRepository } from './call-dashboard-metrics.repository';
import {
  CreateResponseWaitMetricsDto,
  CreateStageMetricsDto,
} from './dto/create-call-dashboard-metrics.dto';

@Injectable()
export class CallDashboardMetricsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: CallDashboardMetricsRepository,
    private readonly audit: AuditService,
  ) {}

  saveStage(id: number, input: CreateStageMetricsDto, requestId: string): Promise<void> {
    return this.save(
      id,
      { providerCallId: input.providerCallId, dropoffStage: input.dropoffStage },
      requestId,
    );
  }

  saveResponseWait(
    id: number,
    input: CreateResponseWaitMetricsDto,
    requestId: string,
  ): Promise<void> {
    if (
      new Set(input.latencyStats.map((stat) => stat.processType)).size !== input.latencyStats.length
    )
      throw new ApiException(400, 'INVALID_REQUEST', '처리 유형은 중복해서 전송할 수 없습니다.');
    return this.save(
      id,
      {
        providerCallId: input.providerCallId,
        totalWaitMs: input.totalWaitMs,
        latencyStats: input.latencyStats
          .map((stat) => ({
            processType: stat.processType,
            totalLatencyMs: stat.totalLatencyMs,
            measurementCount: stat.measurementCount,
          }))
          .sort((a, b) =>
            a.processType < b.processType ? -1 : a.processType > b.processType ? 1 : 0,
          ),
      },
      requestId,
    );
  }

  private async save(
    id: number,
    input: CreateStageMetricsDto | CreateResponseWaitMetricsDto,
    requestId: string,
  ): Promise<void> {
    const dropoff = 'dropoffStage' in input;
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.database.transaction(async (client) => {
      const call = await this.repository.lockCall(client, id);
      if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (call.providerCallId !== input.providerCallId)
        throw new ApiException(403, 'FORBIDDEN', '통화 번호와 AI 통화 ID가 일치하지 않습니다.');
      if (!call.hasAnalysis)
        throw new ApiException(409, 'INVALID_STATE', '통화 최종 분석을 먼저 저장해 주세요.');
      if (!(await this.repository.insert(client, id, input, hash))) {
        if ((await this.repository.findHash(client, id, dropoff)) !== hash)
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '이미 저장한 통화 지표와 내용이 다릅니다.',
          );
        return;
      }
      // PBX 시각은 나중에 보정될 수 있으므로 확정값 재전송은 원래 해시로 먼저 판별한다.
      if ('totalWaitMs' in input && input.totalWaitMs > call.durationMs)
        throw new ApiException(
          422,
          'VALIDATION_FAILED',
          '총 대기시간이 통화시간을 초과할 수 없습니다.',
        );
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'AI',
          targetType: 'CALL_SESSION',
          targetId: id,
          requestId,
          action: dropoff ? 'CALL_DROPOFF_RECORDED' : 'CALL_RESPONSE_WAIT_RECORDED',
        },
        client,
      );
    });
  }
}
