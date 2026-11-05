import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
@Injectable()
export class ConsultationsRepository {
  constructor(private readonly database: DatabaseService) {}
  async activeCount() {
    const row = (
      await this.database.pool.query<{
        activeCallCount: number;
        observedAt: Date;
      }>(
        `SELECT count(*)::int AS "activeCallCount",statement_timestamp() AS "observedAt"
       FROM call_sessions WHERE registered_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL
        AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')`,
      )
    ).rows[0];
    return {
      activeCallCount: row.activeCallCount,
      observedAt: row.observedAt.toISOString(),
    };
  }
}
