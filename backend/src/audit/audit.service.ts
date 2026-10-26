import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { AuditRepository } from './audit.repository';
import { AuditEvent, AuditLog } from './audit.types';
import { AuditQueryDto } from './dto/audit-query.dto';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
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

  recordSuccess(event: AuditEvent, client: PoolClient): Promise<void> {
    return this.repository.insert(event, 'SUCCESS', client);
  }

  async recordFailure(event: AuditEvent, error: unknown): Promise<void> {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    try {
      await this.repository.insert(event, [401, 403].includes(status) ? 'DENIED' : 'FAILED');
    } catch {
      // Preserve the original failure when the audit database is also unavailable.
      this.logger.error({ event: 'audit_write_failed', requestId: event.requestId });
    }
  }

  async findMany(query: AuditQueryDto): Promise<ListResponse<AuditLog>> {
    const from = query.from === undefined ? undefined : Date.parse(query.from);
    const to = query.to === undefined ? undefined : Date.parse(query.to);

    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from >= to)
    ) {
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '조회 기간을 확인해 주세요. 시작 시각은 종료 시각보다 빨라야 합니다.',
      );
    }

    const rows = await this.repository.findMany(query);
    return new ListResponse(rows, query.limit);
  }

  async findOne(id: number): Promise<AuditLog> {
    const row = await this.repository.findOne(id);
    if (!row) throw new ApiException(404, 'NOT_FOUND', '감사 로그를 찾을 수 없습니다.');
    return row;
  }
}
