import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sendEvent } from '@dva/events';
import { ReadScopes, readCallbackUrl } from '@dva/events/read-scope.cjs';
import { requestCardCaller, type CardCallScopeEvent } from '@dva/events/card-call-scope.cjs';
import { ScopeResponseError } from '@dva/events/call-scope.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

interface CallFrame {
  id: string;
  registration: boolean;
  ready: Promise<string | null>;
  resolveReady(address: string | null): void;
  rejectReady(error: Error): void;
  finished: Promise<void>;
  finish(): void;
  address?: string | null;
  remote?: Promise<void>;
}

@Injectable()
export class CardCallScopes {
  private readonly local = new AsyncLocalStorage<CallFrame>();
  private readonly pending = new ReadScopes<CallFrame>(() => this.unavailable());

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  private unavailable() {
    return new ApiException(
      503,
      'DEPENDENCY_UNAVAILABLE',
      '서비스를 일시적으로 사용할 수 없습니다.',
    );
  }

  async transaction<T>(
    actor: number | null,
    work: (client: PoolClient) => Promise<T>,
    registration = false,
  ): Promise<T> {
    if (actor !== null) return this.database.transaction(work);
    let resolveReady!: CallFrame['resolveReady'];
    let rejectReady!: CallFrame['rejectReady'];
    let finish!: CallFrame['finish'];
    const ready = new Promise<string | null>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const frame: CallFrame = {
      id: randomUUID(),
      registration,
      ready,
      resolveReady,
      rejectReady,
      finished,
      finish,
    };
    return this.pending.run(frame.id, frame, () =>
      this.local.run(frame, async () => {
        let result!: T;
        let failure: { error: unknown } | undefined;
        try {
          result = await this.database.transaction(work);
        } catch (error: unknown) {
          failure = { error };
        } finally {
          frame.finish();
        }
        try {
          await frame.remote;
        } catch {
          failure ??= { error: this.unavailable() };
        }
        if (failure) throw failure.error;
        return result;
      }),
    );
  }

  async execute(event: CardCallScopeEvent) {
    await this.pending.use(event.eventId, async (frame) => {
      const address = event.payload.consultationAddress ?? null;
      if (frame.address !== undefined && frame.address !== address) throw this.unavailable();
      frame.address = address;
      frame.resolveReady(address);
      await frame.finished;
    });
    return { eventId: event.eventId, status: 'processed' };
  }

  async caller(callSessionSeq: number) {
    const frame = this.local.getStore();
    const origin = this.config.get('CONSULTATION_URL', { infer: true });
    if (!frame || !origin) throw this.unavailable();
    if (!frame.remote) {
      frame.remote = sendEvent(
        origin + '/internal/card-call-scope',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: frame.id,
          source: 'customer',
          eventType: 'PaymentCardCallScopeRequested',
          payload: {
            customerAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
            ...(frame.registration ? { registration: true } : {}),
          },
        },
        null,
      );
      void frame.remote.then(
        () => {
          if (frame.address === undefined) frame.rejectReady(this.unavailable());
        },
        () => frame.rejectReady(this.unavailable()),
      );
    }
    try {
      const address = await frame.ready;
      return await requestCardCaller(
        readCallbackUrl(origin, '/internal/card-call-scope/caller', address),
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'customer',
          eventType: 'PaymentCardCallerRead',
          payload: { scopeId: frame.id, callSessionSeq },
        },
      );
    } catch (error: unknown) {
      if (error instanceof ScopeResponseError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw this.unavailable();
    }
  }
}
