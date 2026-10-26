import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminsService } from '../admins/admins.service';
import { AdminPublic } from '../admins/admins.types';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { AuthRepository } from './auth.repository';
import { LoginDto } from './dto/auth-request.dto';
import { verifyPassword } from './password';
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
const unauthorized = () =>
  new ApiException(401, 'UNAUTHORIZED', '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.');
@Injectable()
export class AuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: AuthRepository,
    private readonly admins: AdminsService,
    private readonly audit: AuditService,
  ) {}
  async authenticate(token?: string, client?: PoolClient): Promise<AdminPublic> {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) throw unauthorized();
    const account = await this.repository.find(tokenHash(token), client);
    if (!account) throw unauthorized();
    return account;
  }
  async login(input: LoginDto, requestId: string, previousToken?: string) {
    return this.database.transaction(async (client) => {
      // Hold the account lock through password verification and session creation.
      // Password changes use the same lock, so old-password logins cannot survive a reset.
      const account = await this.admins.findForLogin(input.loginId, client);
      const valid = await verifyPassword(input.password, account?.passwordHash);
      if (!account || !valid || account.status !== 'ACTIVE') throw unauthorized();
      const token = randomBytes(32).toString('hex');
      if (previousToken) await this.repository.remove(tokenHash(previousToken), client);
      await this.repository.removeExpired(account.adminUserSeq, client);
      const expiresAt = await this.repository.create(
        tokenHash(token),
        account.adminUserSeq,
        client,
      );
      await this.admins.recordLogin(account.adminUserSeq, client);
      await this.audit.record(
        account.adminUserSeq,
        account.adminUserSeq,
        'ADMIN_LOGIN',
        requestId,
        client,
      );
      return { token, expiresAt };
    });
  }
  async logout(token?: string) {
    if (!token) return;
    try {
      await this.repository.remove(tokenHash(token));
    } catch {
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '로그아웃 처리를 확인할 수 없습니다.');
    }
  }
}
