import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { ApiException } from '../common/errors/api.exception';
import { isZonedDate, orderSnapshot } from '../orders/order-snapshot';
import { inspectOrder } from '../orders/order-submission.validation';
import { CreateIncompleteConsultationDto } from './dto/create-incomplete-consultation.dto';
import { IncompleteConsultationsRepository } from './incomplete-consultations.repository';

@Injectable()
export class IncompleteConsultationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: IncompleteConsultationsRepository,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateIncompleteConsultationDto, requestId: string) {
    if (!isZonedDate(input.endedAt))
      throw new ApiException(400, 'INVALID_REQUEST', '종료 시각을 확인해 주세요.', [
        { field: 'endedAt', reason: 'zonedDateTime' },
      ]);
    const value = {
      eventId: input.eventId,
      providerCallId: input.providerCallId,
      endedAt: new Date(input.endedAt).toISOString(),
      endType: input.endType ?? null,
      systemEvent: input.systemEvent ?? null,
      snapshot: orderSnapshot(input.snapshot),
    };
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return this.database.transaction(async (client) => {
      if (!(await this.repository.lock(client, value.providerCallId)))
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '동일 통화 종료 기록을 처리 중입니다. 같은 이벤트로 재시도해 주세요.',
        );
      const call = await this.repository.call(client, value.providerCallId);
      const previous = await this.repository.previous(client, call.id);
      if (previous) {
        if (previous.requestHash !== hash)
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '이미 저장된 통화 종료 기록과 내용이 다릅니다.',
          );
        return {
          incompleteConsultationSeq: previous.incompleteConsultationSeq,
          callSessionSeq: previous.callSessionSeq,
        };
      }
      if (call.orderSeq !== null)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '주문이 연결된 통화는 접수 전 미완료 상담으로 저장할 수 없습니다.',
        );
      if (call.startedAt && Date.parse(value.endedAt) < call.startedAt.getTime())
        throw new ApiException(
          400,
          'INVALID_REQUEST',
          '종료 시각은 통화 시작 시각보다 빠를 수 없습니다.',
        );
      const saved = await this.repository.insert(
        client,
        call.id,
        value,
        inspectOrder(value.snapshot, Date.parse(value.endedAt)),
        hash,
      );
      await this.audit.recordSuccess(
        {
          actorId: null,
          targetType: 'INCOMPLETE_CONSULTATION',
          targetId: saved.incompleteConsultationSeq,
          action: 'INCOMPLETE_CONSULTATION_RECORDED',
          requestId,
        },
        client,
      );
      return saved;
    });
  }
}
