import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { Persona, PersonaSettings, PersonaStatus, PersonaVersion } from './ai-settings.types';
import { PersonaListQueryDto } from './dto/persona-request.dto';

const VERSION_SELECT = `SELECT v.ai_persona_version_seq AS "aiPersonaVersionSeq",
 v.ai_persona_seq AS "aiPersonaSeq", identity.code, v.version, v.name, v.prompt_text AS "promptText",
 v.voice_id AS "voiceId", v.speaking_rate::float8 AS "speakingRate", v.turn_wait_level AS "turnWaitLevel",
 v.status, v.created_by_admin_user_seq AS "createdByAdminUserSeq", v.created_at AS "createdAt",
 v.application_id AS "applicationId", v.requested_by_admin_user_seq AS "requestedByAdminUserSeq",
 v.requested_at AS "requestedAt", v.applied_at AS "appliedAt", v.last_notified_at AS "lastNotifiedAt",
 v.apply_error_code AS "applyErrorCode"
 FROM ai_persona_versions v JOIN ai_personas identity USING(ai_persona_seq)`;

@Injectable()
export class AiSettingsRepository {
  constructor(private readonly database: DatabaseService) {}

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

  async personas(query: PersonaListQueryDto, id?: number): Promise<Persona[]> {
    const result = await this.database.pool.query<Persona>(
      `SELECT p.ai_persona_seq AS "aiPersonaSeq", p.code, row_to_json(latest) AS "latestVersion",
       (SELECT ai_persona_version_seq FROM ai_persona_versions WHERE ai_persona_seq=p.ai_persona_seq AND status='ACTIVE') AS "activeVersionSeq",
       (SELECT ai_persona_version_seq FROM ai_persona_versions WHERE ai_persona_seq=p.ai_persona_seq AND status='PENDING') AS "pendingVersionSeq"
       FROM ai_personas p JOIN LATERAL (${VERSION_SELECT}
        WHERE v.ai_persona_seq=p.ai_persona_seq ORDER BY v.version DESC LIMIT 1) latest ON true
       WHERE ($1::int IS NULL OR p.ai_persona_seq=$1)
       ORDER BY p.ai_persona_seq DESC LIMIT $2 OFFSET $3`,
      [id ?? null, query.limit + 1, query.offset],
    );
    return result.rows;
  }

  async versions(id: number, query: PersonaListQueryDto): Promise<PersonaVersion[]> {
    return (
      await this.database.pool.query<PersonaVersion>(
        `${VERSION_SELECT} WHERE v.ai_persona_seq=$1 ORDER BY v.version DESC LIMIT $2 OFFSET $3`,
        [id, query.limit + 1, query.offset],
      )
    ).rows;
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
        `INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,voice_id,speaking_rate,turn_wait_level,created_by_admin_user_seq)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ai_persona_version_seq AS id`,
        [
          id,
          version,
          settings.name,
          settings.promptText,
          settings.voiceId,
          settings.speakingRate,
          settings.turnWaitLevel,
          actorId,
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
    await client.query("UPDATE ai_persona_versions SET status='INACTIVE' WHERE status='PENDING'");
    await client.query(
      `UPDATE ai_persona_versions SET status='PENDING',application_id=$2,
     requested_by_admin_user_seq=$3,requested_at=clock_timestamp(),applied_at=NULL,last_notified_at=NULL,apply_error_code=NULL
     WHERE ai_persona_version_seq=$1`,
      [versionId, applicationId, actorId],
    );
  }
}
