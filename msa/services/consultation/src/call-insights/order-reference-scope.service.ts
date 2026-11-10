import { HttpException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  requestPacket,
  validateScopeResult,
  type OrderLookup,
  type ScopeDirective,
  type ScopeResult,
} from '@dva/events/call-event-reference.cjs';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
type Deferred<T> = ReturnType<typeof deferred<T>>;
type Scope = {
  id: string;
  step: number;
  abort: AbortController;
  lookup?: OrderLookup;
  answer?: Deferred<ScopeResult['payload']>;
  next?: Deferred<OrderLookup | null>;
  remote?: Promise<void>;
  error?: ApiException;
  receipts: Map<string, { content: string; result: Promise<ScopeDirective> }>;
};
const unavailable = () =>
  new ApiException(
    503,
    'DEPENDENCY_UNAVAILABLE',
    '참조 주문을 확인할 수 없습니다.',
  );

@Injectable()
export class OrderReferenceScopeService implements OnModuleDestroy {
  private readonly context = new AsyncLocalStorage<Scope>();
  private readonly active = new Map<string, Scope>();
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    const scope: Scope = {
      id: randomUUID(),
      step: -1,
      abort: new AbortController(),
      receipts: new Map(),
    };
    this.active.set(scope.id, scope);
    return this.context.run(scope, async () => {
      try {
        const result = await work();
        if (scope.error) throw scope.error;
        scope.next?.resolve(null);
        await scope.remote;
        return result;
      } catch (error) {
        scope.abort.abort();
        scope.next?.reject(error);
        await scope.remote?.catch(() => undefined);
        throw error;
      } finally {
        scope.abort.abort();
        this.active.delete(scope.id);
      }
    });
  }

  async check(lookup: OrderLookup): Promise<boolean | undefined> {
    const scope = this.context.getStore();
    if (!scope || scope.error) throw scope?.error ?? unavailable();
    if (scope.answer || ++scope.step >= 50) throw unavailable();
    const previous = scope.next;
    scope.next = undefined;
    scope.lookup = { ...lookup };
    scope.answer = deferred<ScopeResult['payload']>();
    const answer = scope.answer.promise;
    if (previous) previous.resolve(scope.lookup);
    else if (!scope.remote) {
      const url = this.config.get('ORDER_URL', { infer: true });
      if (!url) throw unavailable();
      scope.remote = requestPacket(
        url + '/internal/call-event-order-scope',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: scope.id,
          source: 'consultation',
          eventType: 'CallEventOrderScopeRequested',
          payload: {
            callbackAddress:
              this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
            lookup,
          },
        },
        AbortSignal.any([scope.abort.signal, AbortSignal.timeout(30000)]),
      )
        .then((payload) => {
          if (payload !== null) throw unavailable();
        })
        .catch(() => {
          scope.error = unavailable();
          scope.answer?.reject(scope.error);
          scope.next?.reject(scope.error);
          throw scope.error;
        });
      // The business operation awaits its callback first, then the owner's final acknowledgement.
      void scope.remote.catch(() => undefined);
    } else throw unavailable();
    const result = await answer;
    return result.exists ? result.allowed === true : undefined;
  }

  async continue(input: unknown): Promise<ScopeDirective> {
    try {
      validateScopeResult(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_EVENT_ORDER_SCOPE' }, 422);
    }
    const p = input.payload;
    const scope = this.active.get(p.scopeId);
    if (!scope)
      throw new ApiException(
        404,
        'NOT_FOUND',
        '주문 참조 요청을 찾을 수 없습니다.',
      );
    const content = JSON.stringify([
      p.scopeId,
      p.step,
      p.lookup.orderSeq,
      p.lookup.callOrderSeq,
      p.lookup.customerSeq,
      p.exists,
      p.allowed,
    ]);
    const receipt = scope.receipts.get(input.eventId);
    if (receipt) {
      if (receipt.content !== content)
        throw new ApiException(
          409,
          'EVENT_PAYLOAD_CONFLICT',
          '주문 참조 응답이 다릅니다.',
        );
      return receipt.result;
    }
    if (
      !scope.answer ||
      scope.next ||
      scope.step !== p.step ||
      scope.lookup?.orderSeq !== p.lookup.orderSeq ||
      scope.lookup.callOrderSeq !== p.lookup.callOrderSeq ||
      scope.lookup.customerSeq !== p.lookup.customerSeq
    )
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '주문 참조 순서가 다릅니다.',
      );
    scope.next = deferred<OrderLookup | null>();
    const result = scope.next.promise.then((next) => ({ next }));
    scope.receipts.set(input.eventId, { content, result });
    const answer = scope.answer;
    scope.answer = undefined;
    answer.resolve(p);
    return result;
  }

  onModuleDestroy() {
    for (const scope of this.active.values()) {
      scope.error = unavailable();
      scope.answer?.reject(scope.error);
      scope.next?.reject(scope.error);
      scope.abort.abort();
    }
  }
}
