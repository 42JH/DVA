import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ListResponse } from '../common/pagination';
import { ApiException } from '../common/errors/api.exception';
import { AiPersonaClient, validatePersonaOptions } from './ai-persona.client';
import { AiSettingsRepository } from './ai-settings.repository';
import { PersonaApplicationService } from './persona-application.service';
import { PersonaSettings, PersonaVersion } from './ai-settings.types';
import { CreatePersonaDto, PersonaListQueryDto, UpdatePersonaDto } from './dto/persona-request.dto';

const SETTINGS = ['name', 'promptText', 'voiceId', 'speakingRate', 'turnWaitLevel'] as const;

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: AiSettingsRepository,
    private readonly ai: AiPersonaClient,
    private readonly audit: AuditService,
    private readonly applications: PersonaApplicationService,
  ) {}

  async list(query: PersonaListQueryDto) {
    return new ListResponse(await this.repository.personas(query), query.limit);
  }

  async detail(id: number) {
    const persona = (await this.repository.personas({ limit: 1, offset: 0 }, id))[0];
    if (!persona) throw new ApiException(404, 'NOT_FOUND', '페르소나를 찾을 수 없습니다.');
    return persona;
  }

  async versions(id: number, query: PersonaListQueryDto) {
    await this.detail(id);
    return new ListResponse(await this.repository.versions(id, query), query.limit);
  }

  async create(
    input: CreatePersonaDto,
    actorId: number,
    requestId: string,
  ): Promise<PersonaVersion> {
    validatePersonaOptions(input, await this.ai.options());
    return this.database.transaction(async (client) => {
      const id = await this.repository.create(input.code, client);
      const version = await this.repository.append(id, 1, input, actorId, client);
      await this.audit.recordSuccess(
        {
          actorId,
          targetId: version.aiPersonaVersionSeq,
          targetType: 'AI_PERSONA_VERSION',
          action: 'PERSONA_CREATED',
          requestId,
        },
        client,
      );
      return version;
    });
  }

  async update(
    id: number,
    input: UpdatePersonaDto,
    actorId: number,
    requestId: string,
  ): Promise<PersonaVersion> {
    if (!SETTINGS.some((key) => input[key] !== undefined))
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 설정이 필요합니다.');
    const base = await this.repository.latest(id);
    this.requireVersion(base, input.expectedVersion);
    const settings: PersonaSettings = {
      name: input.name ?? base.name,
      promptText: input.promptText ?? base.promptText,
      voiceId: input.voiceId === undefined ? base.voiceId : input.voiceId,
      speakingRate: input.speakingRate === undefined ? base.speakingRate : input.speakingRate,
      turnWaitLevel: input.turnWaitLevel ?? base.turnWaitLevel,
    };
    validatePersonaOptions(settings, await this.ai.options());
    return this.database.transaction(async (client) => {
      await this.repository.lock(client);
      const current = await this.repository.latest(id, client);
      this.requireVersion(current, input.expectedVersion);
      if (SETTINGS.every((key) => current[key] === settings[key])) return current;
      if (current.version === 2147483647)
        throw new ApiException(409, 'INVALID_STATE', '버전 번호 한도를 초과했습니다.');
      const version = await this.repository.append(
        id,
        current.version + 1,
        settings,
        actorId,
        client,
      );
      await this.audit.recordSuccess(
        {
          actorId,
          targetId: version.aiPersonaVersionSeq,
          targetType: 'AI_PERSONA_VERSION',
          action: 'PERSONA_UPDATED',
          requestId,
        },
        client,
      );
      const active = await this.repository.live('ACTIVE', client);
      const pending = await this.repository.live('PENDING', client);
      if (active?.aiPersonaSeq === id || pending?.aiPersonaSeq === id) {
        await this.applications.queue(version.aiPersonaVersionSeq, actorId, requestId, client);
      }
      return (await this.repository.version(version.aiPersonaVersionSeq, client))!;
    });
  }

  private requireVersion(
    value: PersonaVersion | undefined,
    expected: number,
  ): asserts value is PersonaVersion {
    if (!value) throw new ApiException(404, 'NOT_FOUND', '페르소나를 찾을 수 없습니다.');
    if (value.version !== expected)
      throw new ApiException(409, 'VERSION_CONFLICT', '최신 버전을 다시 조회해 주세요.');
  }
}
