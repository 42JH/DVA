import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ListResponse } from '../common/pagination';
import { ApiException } from '../common/errors/api.exception';
import { AiPersonaClient, validatePersonaOptions } from './ai-persona.client';
import { AiSettingsRepository } from './ai-settings.repository';
import { Persona, PersonaSettings, PersonaVersion } from './ai-settings.types';
import { CreatePersonaDto, PersonaListQueryDto, UpdatePersonaDto } from './dto/persona-request.dto';

const SETTINGS = ['name', 'promptText', 'voiceId', 'speakingRate', 'turnWaitLevel'] as const;

@Injectable()
export class AiSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: AiSettingsRepository,
    private readonly ai: AiPersonaClient,
    private readonly audit: AuditService,
  ) {}

  async list(query: PersonaListQueryDto) {
    const page = await this.repository.personas(query);
    return new ListResponse(
      { ...page, rows: await this.withPersonaAuthors(page.rows) },
      query.limit,
    );
  }

  async detail(id: number) {
    const persona = (await this.repository.personas({ limit: 1, offset: 0 }, id)).rows[0];
    if (!persona) throw new ApiException(404, 'NOT_FOUND', '페르소나를 찾을 수 없습니다.');
    return (await this.withPersonaAuthors([persona]))[0];
  }

  async versions(id: number, query: PersonaListQueryDto) {
    if (!(await this.repository.latest(id)))
      throw new ApiException(404, 'NOT_FOUND', '페르소나를 찾을 수 없습니다.');
    const page = await this.repository.versions(id, query);
    return new ListResponse({ ...page, rows: await this.withAuthors(page.rows) }, query.limit);
  }

  async withAuthor(version: PersonaVersion, client?: PoolClient): Promise<PersonaVersion> {
    return (await this.withAuthors([version], client))[0];
  }

  private async withPersonaAuthors(personas: Persona[]): Promise<Persona[]> {
    const versions = await this.withAuthors(
      personas.flatMap((persona) =>
        [persona.latestVersion, persona.activeVersion, persona.pendingVersion].filter(
          (version): version is PersonaVersion => version !== null,
        ),
      ),
    );
    const byId = new Map(versions.map((version) => [version.aiPersonaVersionSeq, version]));
    return personas.map((persona) => ({
      ...persona,
      latestVersion: byId.get(persona.latestVersion.aiPersonaVersionSeq)!,
      headVersion: byId.get(persona.latestVersion.aiPersonaVersionSeq)!,
      activeVersion: persona.activeVersion
        ? byId.get(persona.activeVersion.aiPersonaVersionSeq)!
        : null,
      pendingVersion: persona.pendingVersion
        ? byId.get(persona.pendingVersion.aiPersonaVersionSeq)!
        : null,
    }));
  }

  private async withAuthors(
    versions: PersonaVersion[],
    client?: PoolClient,
  ): Promise<PersonaVersion[]> {
    const names = await this.audit.actorNames(
      'AI_PERSONA_VERSION',
      versions.map((version) => ({
        actorId: version.createdByAdminUserSeq,
        targetId: version.aiPersonaVersionSeq,
      })),
      client,
    );
    return versions.map((version) => ({
      ...version,
      createdByAdminUserName: names.get(version.aiPersonaVersionSeq) ?? null,
    }));
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
      return this.withAuthor(version, client);
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
      if (SETTINGS.every((key) => current[key] === settings[key]))
        return this.withAuthor(current, client);
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
      return this.withAuthor(version, client);
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
