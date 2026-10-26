import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditRepository } from './audit.repository';
@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}
  record(
    actorId: number | null,
    targetId: number | null,
    action: string,
    requestId: string,
    client: PoolClient,
  ) {
    return this.repository.record(actorId, targetId, action, requestId, client);
  }
}
