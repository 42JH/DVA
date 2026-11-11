import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  ApplyError,
  Persona,
  PersonaDraft,
  PersonaSettings,
  PersonaStatus,
  PersonaVersion,
} from './ai-settings.types';
import { PersonaListQueryDto } from './dto/persona-request.dto';

const VERSION_SELECT = `SELECT v.ai_persona_version_seq AS "aiPersonaVersionSeq",
 v.ai_persona_seq AS "aiPersonaSeq", identity.code, v.version, v.name, v.prompt_text AS "promptText",
 CASE WHEN v.role_text='' THEN v.prompt_text ELSE v.role_text END AS role,
 v.personality_text AS personality,v.tone_text AS tone,v.speed_instruction AS "speedInstruction",
 v.backchannel_text AS backchannel,v.interruption_text AS interruption,
 v.voice_id AS "voiceId", v.speaking_rate::float8 AS "speakingRate", v.turn_wait_level AS "turnWaitLevel",
 v.status, v.created_by_admin_user_seq AS "createdByAdminUserSeq", v.created_at AS "createdAt",
 v.application_id AS "applicationId", v.requested_by_admin_user_seq AS "requestedByAdminUserSeq",
 v.requested_at AS "requestedAt", v.applied_at AS "appliedAt", v.last_notified_at AS "lastNotifiedAt",
 v.apply_error_code AS "applyErrorCode"
 FROM ai_persona_versions v JOIN ai_personas identity ON identity.ai_persona_seq=v.ai_persona_seq
 AND identity.deleted_at IS NULL AND v.deleted_at IS NULL`;

const DRAFT_SELECT = `SELECT ai_persona_seq AS "aiPersonaSeq",draft_revision AS "draftRevision",
 base_version AS "baseVersion",name,prompt_text AS "promptText",voice_id AS "voiceId",
 CASE WHEN role_text='' THEN prompt_text ELSE role_text END AS role,
 personality_text AS personality,tone_text AS tone,speed_instruction AS "speedInstruction",
 backchannel_text AS backchannel,interruption_text AS interruption,
 speaking_rate::float8 AS "speakingRate",turn_wait_level AS "turnWaitLevel",
 updated_by_admin_user_seq AS "updatedByAdminUserSeq",created_at AS "createdAt",updated_at AS "updatedAt"
 FROM ai_persona_drafts`;

@Injectable()
export class AiSettingsRepository {
  constructor(private readonly database: DatabaseService) {}

  async deletionTargets(ids: number[], client: PoolClient) {
    return (
      await client.query<{ id: number; active: boolean }>(
        `SELECT p.ai_persona_seq AS id,EXISTS(SELECT 1 FROM ai_persona_versions v
       WHERE v.ai_persona_seq=p.ai_persona_seq AND v.status='ACTIVE' AND v.deleted_at IS NULL) AS active
       FROM ai_personas p WHERE p.ai_persona_seq=ANY($1::int[]) AND p.deleted_at IS NULL
       ORDER BY p.ai_persona_seq FOR UPDATE OF p`,
        [ids],
      )
    ).rows;
  }

  async removeMany(ids: number[], client: PoolClient) {
    const versions = await client.query<{ id: number }>(
      `UPDATE ai_persona_versions SET deleted_at=transaction_timestamp(),status='INACTIVE'
       WHERE ai_persona_seq=ANY($1::int[]) AND deleted_at IS NULL RETURNING ai_persona_version_seq AS id`,
      [ids],
    );
    const drafts = await client.query<{ id: number }>(
      `UPDATE ai_persona_drafts SET deleted_at=transaction_timestamp()
       WHERE ai_persona_seq=ANY($1::int[]) AND deleted_at IS NULL RETURNING ai_persona_seq AS id`,
      [ids],
    );
    await client.query(
      `UPDATE ai_personas SET deleted_at=transaction_timestamp()
       WHERE ai_persona_seq=ANY($1::int[]) AND deleted_at IS NULL`,
      [ids],
    );
    return { versions: versions.rows.map((r) => r.id), drafts: drafts.rows.map((r) => r.id) };
  }

  async authorNames(ids: number[], client?: PoolClient): Promise<Map<number, string | null>> {
    const result = await (client ?? this.database.pool).query<{ id: number; name: string | null }>(
      `SELECT ai_persona_version_seq AS id,CASE WHEN created_at>clock_timestamp()-interval '5 years'
       THEN created_by_admin_user_name END AS name FROM ai_persona_versions WHERE ai_persona_version_seq=ANY($1::int[])`,
      [ids],
    );
    return new Map(result.rows.map((row) => [row.id, row.name]));
  }

  async cancelPending(client: PoolClient): Promise<void> {
    await client.query(
      "UPDATE ai_persona_versions SET status='INACTIVE' WHERE status='PENDING' AND deleted_at IS NULL",
    );
  }

  async apply(versionId: number, client: PoolClient): Promise<void> {
    const previous = await client.query<{ id: number }>(
      "UPDATE ai_persona_versions SET status='INACTIVE' WHERE status='ACTIVE' AND deleted_at IS NULL RETURNING ai_persona_version_seq AS id",
    );
    await client.query(
      "UPDATE ai_persona_versions SET status='ACTIVE',applied_at=clock_timestamp(),apply_error_code=NULL,previous_active_version_seq=$2 WHERE ai_persona_version_seq=$1 AND deleted_at IS NULL",
      [versionId, previous.rows[0]?.id ?? null],
    );
  }

  async applicationError(
    versionId: number,
    applicationId: string,
    code: ApplyError,
    client?: PoolClient,
  ): Promise<void> {
    await (client ?? this.database.pool).query(
      `UPDATE ai_persona_versions SET apply_error_code=$3
     WHERE ai_persona_version_seq=$1 AND application_id=$2 AND status='PENDING' AND deleted_at IS NULL
     AND ($3<>'AI_UNAVAILABLE' OR apply_error_code IS NULL OR apply_error_code='AI_UNAVAILABLE')`,
      [versionId, applicationId, code],
    );
  }

  async claimNotification(): Promise<
    Pick<PersonaVersion, 'aiPersonaVersionSeq' | 'applicationId'> | undefined
  > {
    return (
      await this.database.pool.query<
        Pick<PersonaVersion, 'aiPersonaVersionSeq' | 'applicationId'>
      >(`UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()
     WHERE status='PENDING' AND deleted_at IS NULL AND (last_notified_at IS NULL OR last_notified_at<clock_timestamp()-interval '30 seconds')
     RETURNING ai_persona_version_seq AS "aiPersonaVersionSeq",application_id AS "applicationId"`)
    ).rows[0];
  }

  async notificationRecovered(versionId: number, applicationId: string): Promise<void> {
    await this.database.pool.query(
      `UPDATE ai_persona_versions SET apply_error_code=NULL
     WHERE ai_persona_version_seq=$1 AND application_id=$2 AND status='PENDING' AND deleted_at IS NULL AND apply_error_code='AI_UNAVAILABLE'`,
      [versionId, applicationId],
    );
  }

  async lock(client: PoolClient): Promise<void> {
    // 다른 페르소나의 대기 교체·적용 회신도 같은 순서로 처리한다.
    await client.query('SELECT pg_advisory_xact_lock(20261028,94)');
  }

  async latest(id: number, client?: PoolClient): Promise<PersonaVersion | undefined> {
    return (
      await (client ?? this.database.pool).query<PersonaVersion>(
        `${VERSION_SELECT} WHERE v.ai_persona_seq=$1 ORDER BY v.version DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
  }

  async version(id: number, client?: PoolClient): Promise<PersonaVersion | undefined> {
    return (
      await (client ?? this.database.pool).query<PersonaVersion>(
        `${VERSION_SELECT} WHERE v.ai_persona_version_seq=$1`,
        [id],
      )
    ).rows[0];
  }

  async draft(id: number, client?: PoolClient): Promise<PersonaDraft | undefined> {
    return (
      await (client ?? this.database.pool).query<{ draft: PersonaDraft }>(
        `SELECT row_to_json(draft) AS draft FROM (${DRAFT_SELECT} WHERE ai_persona_seq=$1 AND deleted_at IS NULL) draft`,
        [id],
      )
    ).rows[0]?.draft;
  }

  async saveDraft(
    id: number,
    baseVersion: number,
    settings: PersonaSettings,
    actorId: number,
    client: PoolClient,
  ): Promise<PersonaDraft> {
    await client.query(
      `INSERT INTO ai_persona_drafts(ai_persona_seq,draft_revision,base_version,name,prompt_text,
       voice_id,speaking_rate,turn_wait_level,updated_by_admin_user_seq,
       role_text,personality_text,tone_text,speed_instruction,backchannel_text,interruption_text)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(ai_persona_seq) DO UPDATE SET draft_revision=EXCLUDED.draft_revision,
       base_version=EXCLUDED.base_version,name=EXCLUDED.name,prompt_text=EXCLUDED.prompt_text,
       voice_id=EXCLUDED.voice_id,speaking_rate=EXCLUDED.speaking_rate,
       turn_wait_level=EXCLUDED.turn_wait_level,updated_by_admin_user_seq=EXCLUDED.updated_by_admin_user_seq,
       role_text=EXCLUDED.role_text,personality_text=EXCLUDED.personality_text,
       tone_text=EXCLUDED.tone_text,speed_instruction=EXCLUDED.speed_instruction,
       backchannel_text=EXCLUDED.backchannel_text,interruption_text=EXCLUDED.interruption_text,
       updated_at=clock_timestamp()`,
      [
        id,
        randomUUID(),
        baseVersion,
        settings.name,
        settings.promptText,
        settings.voiceId,
        settings.speakingRate,
        settings.turnWaitLevel,
        actorId,
        settings.role,
        settings.personality,
        settings.tone,
        settings.speedInstruction,
        settings.backchannel,
        settings.interruption,
      ],
    );
    return (await this.draft(id, client))!;
  }

  async deleteDraft(id: number, client: PoolClient): Promise<void> {
    await client.query('DELETE FROM ai_persona_drafts WHERE ai_persona_seq=$1', [id]);
  }

  async live(
    status: Exclude<PersonaStatus, 'INACTIVE'>,
    client?: PoolClient,
  ): Promise<PersonaVersion | undefined> {
    return (
      await (client ?? this.database.pool).query<PersonaVersion>(
        `${VERSION_SELECT} WHERE v.status=$1`,
        [status],
      )
    ).rows[0];
  }

  async personas(query: PersonaListQueryDto, id?: number): Promise<PageRows<Persona>> {
    const result = await readPage<
      Pick<Persona, 'aiPersonaSeq' | 'code'> & {
        details: Omit<Persona, 'aiPersonaSeq' | 'code'>;
      }
    >(
      this.database.pool,
      `SELECT p.ai_persona_seq AS "aiPersonaSeq",p.code FROM ai_personas p
       WHERE p.deleted_at IS NULL AND ($1::int IS NULL OR p.ai_persona_seq=$1)
        AND EXISTS(SELECT 1 FROM ai_persona_versions v WHERE v.ai_persona_seq=p.ai_persona_seq AND v.deleted_at IS NULL)`,
      [id ?? null],
      query,
      '"aiPersonaSeq" DESC',
      `page.*,(SELECT row_to_json(details) FROM (
       SELECT row_to_json(latest) AS "latestVersion",
       row_to_json(latest) AS "headVersion",
       row_to_json(active) AS "activeVersion",row_to_json(pending) AS "pendingVersion",
       row_to_json(draft) AS draft,active."aiPersonaVersionSeq" AS "activeVersionSeq",
       pending."aiPersonaVersionSeq" AS "pendingVersionSeq"
       FROM LATERAL (${VERSION_SELECT}
        WHERE v.ai_persona_seq=page."aiPersonaSeq" ORDER BY v.version DESC LIMIT 1) latest
       LEFT JOIN LATERAL (${VERSION_SELECT}
        WHERE v.ai_persona_seq=page."aiPersonaSeq" AND v.status='ACTIVE') active ON true
       LEFT JOIN LATERAL (${VERSION_SELECT}
        WHERE v.ai_persona_seq=page."aiPersonaSeq" AND v.status='PENDING') pending ON true
       LEFT JOIN LATERAL (${DRAFT_SELECT} WHERE ai_persona_seq=page."aiPersonaSeq" AND deleted_at IS NULL) draft ON true
      ) details) AS details`,
    );
    return {
      ...result,
      rows: result.rows.map(({ details, ...persona }) => ({ ...persona, ...details })),
    };
  }

  async versions(id: number, query: PersonaListQueryDto): Promise<PageRows<PersonaVersion>> {
    return await readPage<PersonaVersion>(
      this.database.pool,
      `${VERSION_SELECT} WHERE v.ai_persona_seq=$1`,
      [id],
      query,
      'version DESC',
    );
  }

  async create(code: string, client: PoolClient): Promise<number> {
    return (
      await client.query<{ id: number }>(
        'INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq AS id',
        [code],
      )
    ).rows[0].id;
  }

  async append(
    id: number,
    version: number,
    settings: PersonaSettings,
    actorId: number,
    client: PoolClient,
  ): Promise<PersonaVersion> {
    const row = (
      await client.query<{ id: number }>(
        `INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,voice_id,speaking_rate,turn_wait_level,created_by_admin_user_seq,created_by_admin_user_name,
        role_text,personality_text,tone_text,speed_instruction,backchannel_text,interruption_text)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT name FROM admin_users WHERE admin_user_seq=$8),$9,$10,$11,$12,$13,$14) RETURNING ai_persona_version_seq AS id`,
        [
          id,
          version,
          settings.name,
          settings.promptText,
          settings.voiceId,
          settings.speakingRate,
          settings.turnWaitLevel,
          actorId,
          settings.role,
          settings.personality,
          settings.tone,
          settings.speedInstruction,
          settings.backchannel,
          settings.interruption,
        ],
      )
    ).rows[0];
    return (await this.version(row.id, client))!;
  }

  async queue(
    versionId: number,
    applicationId: string,
    actorId: number,
    client: PoolClient,
  ): Promise<void> {
    await this.cancelPending(client);
    await client.query(
      `UPDATE ai_persona_versions SET status='PENDING',application_id=$2,
     requested_by_admin_user_seq=$3,requested_at=clock_timestamp(),applied_at=NULL,last_notified_at=NULL,apply_error_code=NULL
     WHERE ai_persona_version_seq=$1 AND deleted_at IS NULL`,
      [versionId, applicationId, actorId],
    );
  }
}
