import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  commandHash,
  requestScope,
  ScopeResponseError,
  type CallerScope,
  type CallScopeCommand,
  type ScopeEvent,
} from '@dva/events/call-scope.cjs';
import { AuditService } from '../audit/audit.service';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class CallScopeService {
  private readonly local = new AsyncLocalStorage<ScopeEvent>();
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
  ) {}
  get active() {
    return this.local.getStore() !== undefined;
  }
  get caller(): CallerScope | null {
    const event = this.local.getStore();
    if (!event) throw new Error('Call scope is not held');
    return event.payload.caller ?? null;
  }
  run<T>(event: ScopeEvent, work: () => Promise<T>): Promise<T> {
    return this.local.run(event, work);
  }
  header(value: string | undefined, address = false): number {
    if (
      value === undefined ||
      !/^[0-9]+(?![\s\S])/.test(value) ||
      Number(value) < 1 ||
      Number(value) > 2147483647
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        address
          ? 'AI 고객 기본 주소 수정에는 유효한 call_session_seq가 필요합니다.'
          : 'AI 주소록 API에는 유효한 call_session_seq가 필요합니다.',
      );
    return Number(value);
  }
  async execute<T>(command: CallScopeCommand): Promise<T> {
    const origin = this.config.get('CONSULTATION_URL', { infer: true });
    try {
      if (!origin) throw new Error('Call scope unavailable');
      return (await requestScope(
        origin + '/internal/call-scope',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'customer',
          eventType: 'CallScopedCustomerRequested',
          payload: { command },
        },
      )) as T;
    } catch (error) {
      if (error instanceof ScopeResponseError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const event = this.local.getStore();
    if (!event) return this.database.transaction(work);
    const hash = commandHash(event.payload.command);
    let replay = false;
    const result = await this.database.transaction(async (client) => {
      // shortcut: retain hashed command receipts until the cross-service retention worker is ported.
      const inserted = await client.query(
        'INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING RETURNING event_id',
        [event.eventId, event.source, event.eventType, { requestHash: hash }],
      );
      if (!inserted.rowCount) {
        const existing = (
          await client.query<{
            source: string;
            event_type: string;
            payload: { requestHash: string; result: T };
          }>('SELECT source,event_type,payload FROM inbox_events WHERE event_id=$1', [
            event.eventId,
          ])
        ).rows[0];
        if (
          existing.source !== event.source ||
          existing.event_type !== event.eventType ||
          existing.payload.requestHash !== hash
        )
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '같은 이벤트의 내용을 변경할 수 없습니다.',
          );
        replay = true;
        return existing.payload.result;
      }
      const value = await work(client);
      await client.query('UPDATE inbox_events SET payload=payload || $2::jsonb WHERE event_id=$1', [
        event.eventId,
        JSON.stringify({ result: value ?? null }),
      ]);
      return value;
    });
    if (replay) await this.audit.flush();
    return result;
  }
}
