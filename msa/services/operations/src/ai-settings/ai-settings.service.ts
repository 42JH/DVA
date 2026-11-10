import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ListResponse } from '../common/pagination';
import { ApiException } from '../common/errors/api.exception';
import { AiPersonaClient, validatePersonaOptions } from './ai-persona.client';
import { AiSettingsRepository } from './ai-settings.repository';
import { Persona, PersonaDraft, PersonaSettings, PersonaVersion } from './ai-settings.types';
import { composePersonaPrompt, PERSONA_PROMPT_FIELDS } from './persona-prompt';
import {
  CommitPersonaDraftDto,
  CreatePersonaDto,
  PersonaListQueryDto,
  UpdatePersonaDto,
} from './dto/persona-request.dto';

const SETTINGS = [
  'name',
  ...PERSONA_PROMPT_FIELDS,
  'voiceId',
  'speakingRate',
  'turnWaitLevel',
] as const;

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
    const names = await this.repository.authorNames(
      versions.map((version) => version.aiPersonaVersionSeq),
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
    const settings = { ...input, promptText: composePersonaPrompt(input) };
    validatePersonaOptions(settings, await this.ai.options());
    return this.database.transaction(async (client) => {
      const id = await this.repository.create(input.code, client);
      const version = await this.repository.append(id, 1, settings, actorId, client);
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
  ): Promise<PersonaDraft> {
    if (!SETTINGS.some((key) => input[key] !== undefined))
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 설정이 필요합니다.');
    const base = await this.repository.latest(id);
    this.requireVersion(base, input.expectedVersion);
    const draft = await this.repository.draft(id);
    this.requireDraft(draft, input.expectedDraftRevision, base.version);
    const source = draft ?? base;
    const settings: PersonaSettings = {
      name: input.name ?? source.name,
      role: input.role ?? source.role,
      personality: input.personality ?? source.personality,
      tone: input.tone ?? source.tone,
      speedInstruction: input.speedInstruction ?? source.speedInstruction,
      backchannel: input.backchannel ?? source.backchannel,
      interruption: input.interruption ?? source.interruption,
      promptText: source.promptText,
      voiceId: input.voiceId === undefined ? source.voiceId : input.voiceId,
      speakingRate: input.speakingRate === undefined ? source.speakingRate : input.speakingRate,
      turnWaitLevel: input.turnWaitLevel ?? source.turnWaitLevel,
    };
    if (PERSONA_PROMPT_FIELDS.some((key) => input[key] !== undefined && input[key] !== source[key]))
      settings.promptText = composePersonaPrompt(settings);
    validatePersonaOptions(settings, await this.ai.options());
    return this.database.transaction(async (client) => {
      await this.repository.lock(client);
      const current = await this.repository.latest(id, client);
      this.requireVersion(current, input.expectedVersion);
      const currentDraft = await this.repository.draft(id, client);
      this.requireDraft(currentDraft, input.expectedDraftRevision, current.version);
      if (currentDraft && SETTINGS.every((key) => currentDraft[key] === settings[key]))
        return currentDraft;
      const saved = await this.repository.saveDraft(id, current.version, settings, actorId, client);
      await this.audit.recordSuccess(
        {
          actorId,
          targetId: id,
          targetType: 'AI_PERSONA',
          action: 'PERSONA_DRAFT_SAVED',
          requestId,
        },
        client,
      );
      return saved;
    });
  }

  async commitDraft(
    id: number,
    input: CommitPersonaDraftDto,
    actorId: number,
    requestId: string,
  ): Promise<PersonaVersion> {
    const base = await this.repository.latest(id);
    this.requireVersion(base, input.expectedVersion);
    const draft = await this.repository.draft(id);
    if (!draft) throw new ApiException(409, 'INVALID_STATE', '확정할 초안이 없습니다.');
    this.requireDraft(draft, input.expectedDraftRevision, base.version);
    validatePersonaOptions(draft, await this.ai.options());
    return this.database.transaction(async (client) => {
      await this.repository.lock(client);
      const current = await this.repository.latest(id, client);
      this.requireVersion(current, input.expectedVersion);
      const currentDraft = await this.repository.draft(id, client);
      if (!currentDraft) throw new ApiException(409, 'INVALID_STATE', '확정할 초안이 없습니다.');
      this.requireDraft(currentDraft, input.expectedDraftRevision, current.version);
      let version = current;
      if (!SETTINGS.every((key) => current[key] === currentDraft[key])) {
        if (current.version === 2147483647)
          throw new ApiException(409, 'INVALID_STATE', '버전 번호 한도를 초과했습니다.');
        version = await this.repository.append(
          id,
          current.version + 1,
          currentDraft,
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
      }
      await this.repository.deleteDraft(id, client);
      await this.audit.recordSuccess(
        {
          actorId,
          targetId: id,
          targetType: 'AI_PERSONA',
          action: 'PERSONA_DRAFT_COMMITTED',
          requestId,
        },
        client,
      );
      return this.withAuthor(version, client);
    });
  }

  private requireDraft(
    draft: PersonaDraft | undefined,
    expected: string | null,
    headVersion: number,
  ): void {
    if ((draft?.draftRevision ?? null) !== expected || (draft && draft.baseVersion !== headVersion))
      throw new ApiException(409, 'VERSION_CONFLICT', '초안과 HEAD를 다시 조회해 주세요.');
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
