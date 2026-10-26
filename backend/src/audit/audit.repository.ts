import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
@Injectable()
export class AuditRepository {
  async record(
    actorId: number | null,
    targetId: number | null,
    action: string,
    requestId: string,
    client: PoolClient,
  ) {
    await client.query(
      `INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata)
   VALUES($1,$2,$3,'ADMIN_USER',$4,$5,'SUCCESS','{}')`,
      [actorId === null ? 'SYSTEM' : 'ADMIN', actorId, action, targetId, requestId],
    );
  }
}
