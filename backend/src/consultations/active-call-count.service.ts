import {
  Injectable,
  Logger,
  MessageEvent,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Client } from 'pg';
import { Observable, Subject } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { ConsultationsRepository } from './consultations.repository';
import { ActiveCallCountDto } from './dto/active-call-count.dto';

const unavailable = () =>
  new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '진행 통화 수를 확인할 수 없습니다.');

@Injectable()
export class ActiveCallCountService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ActiveCallCountService.name);
  private readonly updates = new Subject<ActiveCallCountDto | null>();
  private current?: ActiveCallCountDto;
  private listener?: Client;
  private connecting?: Promise<void>;
  private refreshing?: Promise<ActiveCallCountDto>;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private dirty = true;
  private changes = 0;
  private lastRead = 0;
  private lastConnect = -Infinity;

  constructor(
    private readonly repository: ConsultationsRepository,
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.stopped || this.running || !this.updates.observed) return;
      this.running = this.tick()
        .catch(() => this.logger.warn({ event: 'active_call_count_unavailable' }))
        .finally(() => {
          this.running = undefined;
        });
    }, 100);
    this.timer.unref();
  }

  async read(): Promise<ActiveCallCountDto> {
    try {
      return await this.repository.activeCount();
    } catch {
      throw unavailable();
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) throw unavailable();
    if (this.listener) return;
    if (this.connecting) return this.connecting;
    this.lastConnect = performance.now();
    const client = new Client(this.database.pool.options);
    const disconnected = () => {
      if (this.listener === client) {
        this.listener = undefined;
        this.dirty = true;
      }
    };
    client.on('notification', () => {
      this.dirty = true;
      this.changes++;
    });
    client.on('end', disconnected);
    client.on('error', () => {
      disconnected();
      void client.end().catch(() => {});
    });
    this.connecting = (async () => {
      try {
        await client.connect();
        await client.query('LISTEN call_sessions_changed');
        if (this.stopped) {
          await client.end();
          throw unavailable();
        }
        this.listener = client;
        this.dirty = true;
      } catch {
        await client.end().catch(() => {});
        throw unavailable();
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  private refresh(): Promise<ActiveCallCountDto> {
    if (this.refreshing) return this.refreshing;
    this.dirty = false;
    this.changes = 0;
    this.lastRead = performance.now();
    this.refreshing = this.read()
      .then((snapshot) => {
        const changed = snapshot.activeCallCount !== this.current?.activeCallCount;
        this.current = snapshot;
        if (changed) this.updates.next(snapshot);
        return snapshot;
      })
      .catch((error: unknown) => {
        this.dirty = true;
        this.updates.next(null);
        throw error;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async tick(): Promise<void> {
    const elapsed = performance.now() - this.lastRead;
    if (!this.listener && performance.now() - this.lastConnect >= 5000)
      await this.connect().catch(() => {});
    const delay = (this.current?.activeCallCount ?? 0) > 100 || this.changes >= 10 ? 1000 : 100;
    // NOTIFY 연결 복구 중에도 주기 조회로 누락된 변경을 보완한다.
    if ((this.dirty && elapsed >= delay) || elapsed >= 5000) await this.refresh();
  }

  async stream(token: string): Promise<Observable<MessageEvent>> {
    await this.connect();
    const initial = await this.refresh();
    await this.auth.authenticate(token);
    return new Observable<MessageEvent>((subscriber) => {
      const subscription = this.updates.subscribe({
        next: (snapshot) => {
          if (snapshot === null) {
            subscriber.next({ type: 'stream-error', data: { code: 'DEPENDENCY_UNAVAILABLE' } });
            subscriber.complete();
          } else subscriber.next({ type: 'active-call-count', data: snapshot });
        },
        complete: () => subscriber.complete(),
      });
      subscriber.next({ type: 'active-call-count', data: this.current ?? initial });
      let checking = false;
      const heartbeat = setInterval(() => {
        if (checking || subscriber.closed) return;
        checking = true;
        void this.auth
          .authenticate(token)
          .then(() => {
            if (!subscriber.closed)
              subscriber.next({
                type: 'heartbeat',
                data: { observedAt: this.current?.observedAt },
              });
          })
          .catch((error: unknown) => {
            const unauthorized =
              error instanceof ApiException && [401, 403].includes(error.getStatus());
            subscriber.next({
              type: unauthorized ? 'session-expired' : 'stream-error',
              data: { code: unauthorized ? 'UNAUTHORIZED' : 'DEPENDENCY_UNAVAILABLE' },
            });
            subscriber.complete();
          })
          .finally(() => {
            checking = false;
          });
      }, 5000);
      heartbeat.unref();
      return () => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
      };
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.updates.complete();
    await this.running?.catch(() => {});
    await this.connecting?.catch(() => {});
    await this.refreshing?.catch(() => {});
    const listener = this.listener;
    this.listener = undefined;
    await listener?.end();
  }
}
