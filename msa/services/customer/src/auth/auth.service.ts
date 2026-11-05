import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ADMIN_ROLES, type AdminPublic } from '../admins/admins.types';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';

const unauthorized = () =>
  new ApiException(401, 'UNAUTHORIZED', '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.');
const unavailable = () => new ApiException(500, 'INTERNAL_ERROR', '서버 오류가 발생했습니다.');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  private async request(path: string, body?: object): Promise<Response> {
    return fetch(this.config.get('OPERATIONS_URL', { infer: true }) + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
      headers: {
        Authorization: `Bearer ${this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true })}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async authenticate(token?: string): Promise<AdminPublic> {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) throw unauthorized();
    let value: unknown;
    try {
      const response = await this.request('/internal/auth/session', { sessionToken: token });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (response.status === 401) throw unauthorized();
        throw unavailable();
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw unavailable();
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 8192) throw unavailable();
        chunks.push(chunk);
      }
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw unavailable();
    }
    if (
      !object(value) ||
      !Number.isInteger(value.adminUserSeq) ||
      Number(value.adminUserSeq) < 1 ||
      Number(value.adminUserSeq) > 2147483647 ||
      typeof value.loginId !== 'string' ||
      !/^[A-Za-z0-9]{1,20}$/.test(value.loginId) ||
      typeof value.name !== 'string' ||
      !/\S/u.test(value.name) ||
      !ADMIN_ROLES.includes(value.role as AdminPublic['role']) ||
      value.status !== 'ACTIVE' ||
      !date(value.createdAt) ||
      !(value.lastLoginAt === null || date(value.lastLoginAt))
    )
      throw unavailable();
    return {
      adminUserSeq: value.adminUserSeq as number,
      loginId: value.loginId,
      name: value.name,
      role: value.role as AdminPublic['role'],
      status: 'ACTIVE',
      createdAt: new Date(value.createdAt),
      lastLoginAt: value.lastLoginAt === null ? null : new Date(value.lastLoginAt),
    };
  }

  async readiness(): Promise<void> {
    const ready = await this.request('/operations/health/ready');
    await ready.body?.cancel();
    if (!ready.ok) throw unavailable();
    // A DTO rejection proves the private route exists and accepted the service token.
    const auth = await this.request('/internal/auth/session', { sessionToken: '' });
    await auth.body?.cancel();
    if (auth.status !== 400) throw unavailable();
  }
}
