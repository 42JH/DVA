import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { AiSettingsRepository } from './ai-settings.repository';
import { AiPersonaClient, validatePersonaOptions } from './ai-persona.client';
import { PersonaVersion } from './ai-settings.types';
import { ActivatePersonaDto, PersonaApplyResultDto } from './dto/persona-application.dto';

@Injectable()
export class PersonaApplicationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PersonaApplicationService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: AiSettingsRepository,
    private readonly ai: AiPersonaClient,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async runtime(status: 'ACTIVE' | 'PENDING'): Promise<PersonaVersion> {
    const version = await this.repository.live(status);
    if (!version)
      throw new ApiException(
        404,
        'NOT_FOUND',
        status === 'ACTIVE' ? '적용된 페르소나가 없습니다.' : '대기 중인 페르소나가 없습니다.',
      );
    return version;
  }

  async request(
    id: number,
    input: ActivatePersonaDto,
    actorId: number,
    requestId: string,
  ): Promise<PersonaVersion> {
    const source = await this.repository.version(input.aiPersonaVersionSeq);
    if (!source || source.aiPersonaSeq !== id)
      throw new ApiException(404, 'NOT_FOUND', '해당 페르소나의 버전을 찾을 수 없습니다.');
    validatePersonaOptions(source, await this.ai.options());
    return this.database.transaction(async (client) => {
      await this.repository.lock(client);
      const latest = await this.repository.latest(id, client);
      if (latest?.version !== input.expectedVersion)
        throw new ApiException(409, 'VERSION_CONFLICT', '최신 저장 버전을 다시 조회해 주세요.');
      if (latest.aiPersonaVersionSeq !== input.aiPersonaVersionSeq)
        throw new ApiException(409, 'VERSION_CONFLICT', '현재 HEAD 버전을 다시 조회해 주세요.');
      return this.queueOrReuse(latest, actorId, requestId, client);
    });
  }

  private async queueOrReuse(
    target: PersonaVersion,
    actorId: number,
    requestId: string,
    client: PoolClient,
  ): Promise<PersonaVersion> {
    if (target.status === 'ACTIVE') {
      const pending = await this.repository.live('PENDING', client);
      if (pending) {
        await this.repository.cancelPending(client);
        await this.audit.recordSuccess(
          {
            actorId,
            targetId: pending.aiPersonaVersionSeq,
            targetType: 'AI_PERSONA_VERSION',
            action: 'PERSONA_PENDING_CANCELLED',
            requestId,
          },
          client,
        );
      }
      return target;
    }
    if (target.status === 'PENDING' && target.applyErrorCode === null) return target;
    await this.queue(target.aiPersonaVersionSeq, actorId, requestId, client);
    return (await this.repository.version(target.aiPersonaVersionSeq, client))!;
  }

  private async queue(
    versionId: number,
    actorId: number,
    requestId: string,
    client: PoolClient,
  ): Promise<void> {
    const pending = await this.repository.live('PENDING', client);
    if (pending)
      await this.audit.recordSuccess(
        {
          actorId,
          targetId: pending.aiPersonaVersionSeq,
          targetType: 'AI_PERSONA_VERSION',
          action: 'PERSONA_PENDING_REPLACED',
          requestId,
        },
        client,
      );
    await this.repository.queue(versionId, randomUUID(), actorId, client);
    await this.audit.recordSuccess(
      {
        actorId,
        targetId: versionId,
        targetType: 'AI_PERSONA_VERSION',
        action: 'PERSONA_APPLY_REQUESTED',
        requestId,
      },
      client,
    );
  }

  async result(input: PersonaApplyResultDto, requestId: string): Promise<PersonaVersion> {
    // shortcut: AI의 통화별 버전 고정과 신규 통화 진입 잠금을 신뢰한다. 다중 인스턴스 전환 시 동기화 검증이 필요하다.
    if ((input.result === 'FAILED') !== (input.errorCode !== undefined))
      throw new ApiException(400, 'INVALID_REQUEST', '실패 결과에만 errorCode가 필요합니다.');
    return this.database.transaction(async (client) => {
      await this.repository.lock(client);
      const target = await this.repository.version(input.aiPersonaVersionSeq, client);
      if (!target || target.applicationId !== input.applicationId)
        throw new ApiException(
          409,
          'VERSION_CONFLICT',
          '교체되었거나 유효하지 않은 적용 요청입니다.',
        );
      if (target.status === 'ACTIVE' && input.result === 'APPLIED') return target;
      if (target.status !== 'PENDING')
        throw new ApiException(409, 'VERSION_CONFLICT', '현재 대기 중인 적용 요청이 아닙니다.');
      const event = {
        actorId: null,
        actorType: 'AI' as const,
        targetId: target.aiPersonaVersionSeq,
        targetType: 'AI_PERSONA_VERSION',
        action: input.result === 'APPLIED' ? 'PERSONA_APPLIED' : 'PERSONA_APPLY_FAILED',
        requestId,
      };
      if (input.result === 'FAILED') {
        await this.repository.applicationError(
          target.aiPersonaVersionSeq,
          input.applicationId,
          input.errorCode!,
          client,
        );
        if (target.applyErrorCode !== input.errorCode)
          await this.audit.recordResult(event, 'FAILED', client);
      } else {
        await this.repository.apply(target.aiPersonaVersionSeq, client);
        await this.audit.recordSuccess(event, client);
      }
      return (await this.repository.version(target.aiPersonaVersionSeq, client))!;
    });
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('AI_PERSONA_TOKEN', { infer: true })) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.notifyPending()
      .catch(() => {
        this.logger.warn({ event: 'persona_notification_failed' });
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async notifyPending(): Promise<void> {
    if (!this.config.get('AI_PERSONA_TOKEN', { infer: true })) return;
    const pending = await this.repository.claimNotification();
    if (!pending) return;
    try {
      await this.ai.notify(pending.aiPersonaVersionSeq, pending.applicationId!);
      await this.repository.notificationRecovered(
        pending.aiPersonaVersionSeq,
        pending.applicationId!,
      );
    } catch {
      // 전송 성공 여부가 불명이어도 대기는 보존하고 같은 요청으로 다시 알린다.
      await this.repository.applicationError(
        pending.aiPersonaVersionSeq,
        pending.applicationId!,
        'AI_UNAVAILABLE',
      );
    }
  }
}
