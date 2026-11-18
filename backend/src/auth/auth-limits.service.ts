import { Injectable } from '@nestjs/common';
import { RateLimitException } from '../common/errors/api.exception';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
interface Counter {
  attempts: number[];
  blockedUntil: number;
  expiresAt: number;
}

@Injectable()
export class AuthLimitsService {
  // shortcut: one backend process; share counters before adding replicas or workers.
  private readonly counters = new Map<string, Counter>();
  private nextSweep = 0;
  private activePasswordWork = 0;

  private now(): number {
    return Date.now();
  }

  private counter(key: string, lifetime: number): Counter {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [storedKey, value] of this.counters)
        if (value.expiresAt <= now) this.counters.delete(storedKey);
      this.nextSweep = now + MINUTE;
    }
    const existing = this.counters.get(key);
    if (existing && existing.expiresAt > now) return existing;
    this.counters.delete(key);
    // Do not evict live counters: that would reset an attacker's allowance.
    if (this.counters.size >= 10_000) throw new RateLimitException(60);
    const value = { attempts: [], blockedUntil: 0, expiresAt: now + lifetime };
    this.counters.set(key, value);
    return value;
  }

  checkSignup(ip: string): void {
    const now = this.now();
    const counter = this.counter(`signup:${ip}`, DAY);
    counter.attempts = counter.attempts.filter((time) => time > now - DAY);
    const recent = counter.attempts.filter((time) => time > now - 10 * MINUTE);
    const wait = Math.max(
      recent.length >= 5 ? recent[0] + 10 * MINUTE - now : 0,
      counter.attempts.length >= 20 ? counter.attempts[0] + DAY - now : 0,
    );
    if (wait > 0) throw new RateLimitException(Math.ceil(wait / 1000));
    counter.attempts.push(now);
    counter.expiresAt = now + DAY;
  }

  checkLogin(loginId: string): void {
    const counter = this.counter(`login:${loginId}`, 15 * MINUTE);
    const now = this.now();
    if (counter.blockedUntil > now)
      throw new RateLimitException(Math.ceil((counter.blockedUntil - now) / 1000));
    if (counter.blockedUntil) {
      counter.blockedUntil = 0;
      counter.attempts = [];
    }
  }

  recordLoginFailure(loginId: string): void {
    const now = this.now();
    const counter = this.counter(`login:${loginId}`, 15 * MINUTE);
    if (counter.blockedUntil > now) return;
    counter.attempts = counter.attempts.filter((time) => time > now - 15 * MINUTE);
    counter.attempts.push(now);
    if (counter.attempts.length >= 5) counter.blockedUntil = now + 5 * MINUTE;
    counter.expiresAt = now + 15 * MINUTE;
  }

  clearLogin(loginId: string): void {
    this.counters.delete(`login:${loginId}`);
  }

  async withPasswordWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.activePasswordWork >= 2) throw new RateLimitException(1);
    this.activePasswordWork++;
    try {
      return await work();
    } finally {
      this.activePasswordWork--;
    }
  }
}
