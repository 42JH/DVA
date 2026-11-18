import { readPage, PageRows } from '../common/pagination-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuditEvent, AuditLog, AuditResult } from './audit.types';
import { AuditQueryDto } from './dto/audit-query.dto';

const AUDIT_SELECT = `SELECT
        audit_log_seq AS "auditLogSeq",
        actor_type AS "actorType",
        CASE WHEN actor_type='ADMIN' THEN '운영자' ELSE actor_type END AS "actorLabel",
        actor_seq AS "actorSeq",
        actor_name AS "actorName",
        action,
        target_type AS "targetType",
        target_seq AS "targetSeq",
        target_admin_name AS "targetAdminName",
        request_id AS "requestId",
        result,
        jsonb_strip_nulls(jsonb_build_object(
          'organizationSeq',metadata->'organizationSeq','organizationName',metadata->'organizationName',
          'departmentSeq',metadata->'departmentSeq','departmentName',metadata->'departmentName','customerSeq',metadata->'customerSeq',
          'amountBefore',metadata->'amountBefore','amountAfter',metadata->'amountAfter',
          'orderParcelSeqs',metadata->'orderParcelSeqs','billingMonth',metadata->'billingMonth',
          'paymentMethodType',metadata->'paymentMethodType','reason',metadata->'reason',
          'hasComplaint',metadata->'hasComplaint','complaintCount',metadata->'complaintCount')) AS metadata,
        occurred_at AS "occurredAt"
      FROM audit_logs`;

@Injectable()
export class AuditRepository {
  constructor(private readonly database: DatabaseService) {}

  async record(
    actorId: number | null,
    targetId: number | null,
    action: string,
    requestId: string,
    client: PoolClient,
  ) {
    await this.insert(
      { actorId, targetId, action, requestId, targetType: 'ADMIN_USER' },
      'SUCCESS',
      client,
    );
  }

  async insert(
    event: AuditEvent,
    result: AuditResult,
    client?: PoolClient,
    occurredAt?: string,
  ): Promise<void> {
    const actorType = event.actorType ?? (event.actorId === null ? 'SYSTEM' : 'ADMIN');
    await (client ?? this.database.pool).query(
      `INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata,
         actor_name,target_admin_name,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$9::jsonb,
         CASE WHEN $1='AI' THEN 'AI' WHEN $1='ADMIN' THEN COALESCE($8::text,
           (SELECT name FROM admin_users WHERE admin_user_seq=$2),
           (SELECT target_admin_name FROM audit_logs
            WHERE target_type='ADMIN_USER' AND target_seq=$2
              AND action='ADMIN_DELETED' AND result='SUCCESS'
            ORDER BY occurred_at DESC,audit_log_seq DESC LIMIT 1)) END,
         CASE WHEN $4='ADMIN_USER' THEN COALESCE(
           (SELECT name FROM admin_users WHERE admin_user_seq=$5),
           (SELECT target_admin_name FROM audit_logs
            WHERE target_type='ADMIN_USER' AND target_seq=$5
              AND action='ADMIN_DELETED' AND result='SUCCESS'
            ORDER BY occurred_at DESC,audit_log_seq DESC LIMIT 1)) END,COALESCE($10::timestamptz,CURRENT_TIMESTAMP))`,
      [
        actorType,
        event.actorId,
        event.action,
        event.targetType,
        event.targetId,
        event.requestId,
        result,
        event.actorName ?? null,
        JSON.stringify(event.metadata ?? {}),
        occurredAt ?? null,
      ],
    );
  }

  async findMany(query: AuditQueryDto): Promise<PageRows<AuditLog>> {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (query.actorType !== undefined) {
      values.push(query.actorType);
      conditions.push(`actor_type = $${values.length}`);
    }

    if (query.actorSeq !== undefined) {
      values.push(query.actorSeq);
      conditions.push(`actor_seq = $${values.length}`);
    }

    if (query.action !== undefined) {
      values.push(query.action);
      conditions.push(`action = $${values.length}`);
    }

    if (query.targetType !== undefined) {
      values.push(query.targetType);
      conditions.push(`target_type = $${values.length}`);
    }

    if (query.targetSeq !== undefined) {
      values.push(query.targetSeq);
      conditions.push(`target_seq = $${values.length}`);
    }

    if (query.result !== undefined) {
      values.push(query.result);
      conditions.push(`result = $${values.length}`);
    }

    if (query.from !== undefined) {
      values.push(query.from);
      conditions.push(`occurred_at >= $${values.length}::timestamptz`);
    }

    if (query.to !== undefined) {
      values.push(query.to);
      conditions.push(`occurred_at < $${values.length}::timestamptz`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await readPage<AuditLog>(
      this.database.pool,
      `${AUDIT_SELECT}
      ${where}`,
      values,
      query,
      '"occurredAt" DESC,"auditLogSeq" DESC',
    );

    return result;
  }
  async findOne(id: number): Promise<AuditLog | undefined> {
    const result = await this.database.pool.query<AuditLog>(
      `${AUDIT_SELECT} WHERE audit_log_seq = $1`,
      [id],
    );
    return result.rows[0];
  }

  async actorNames(
    targetType: string,
    references: Array<Pick<AuditEvent, 'actorId' | 'targetId'>>,
    client?: PoolClient,
  ) {
    return (
      await (client ?? this.database.pool).query<{ targetId: number; name: string | null }>(
        `SELECT reference."targetId",COALESCE(event.actor_name,
          (SELECT name FROM admin_users WHERE admin_user_seq=reference."actorId")) AS name
         FROM jsonb_to_recordset($2::jsonb) AS reference("targetId" int,"actorId" int)
         LEFT JOIN LATERAL (
           SELECT actor_name FROM audit_logs
           WHERE target_type=$1 AND target_seq=reference."targetId"
             AND actor_type='ADMIN' AND actor_seq=reference."actorId"
             AND result='SUCCESS' AND actor_name IS NOT NULL
           ORDER BY occurred_at,audit_log_seq LIMIT 1
         ) event ON true`,
        [targetType, JSON.stringify(references)],
      )
    ).rows;
  }
}
