import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminsService } from '../admins/admins.service';
import { AdminPublic } from '../admins/admins.types';
import { UpdateAdminDto } from '../admins/dto/admin-query.dto';
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
  private async lockAuthorized(
    token: string,
    targetId: number,
    systemOnly: boolean,
    client: PoolClient,
  ) {
    const before = await this.authenticate(token, client);
    const accounts = await this.admins.lockAccounts([before.adminUserSeq, targetId], client);
    const actor = await this.authenticate(token, client);
    if (systemOnly && actor.role !== 'SYSTEM_ADMIN')
      throw new ApiException(403, 'FORBIDDEN', '접근 권한이 없습니다.');
    const target = accounts.find((account) => account.adminUserSeq === targetId);
    if (!target) throw new ApiException(404, 'NOT_FOUND', '관리자를 찾을 수 없습니다.');
    return { actor, target };
  }
  async updateAdmin(token: string, id: number, input: UpdateAdminDto, requestId: string) {
    await this.database.transaction(async (client) => {
      // Serialize role changes so concurrent demotions cannot remove the last administrator.
      await this.admins.serializeAccessChanges(client);
      const { actor, target } = await this.lockAuthorized(token, id, true, client);
      await this.admins.updateAccess(target, input, client);
      await this.audit.record(actor.adminUserSeq, id, 'ADMIN_ACCESS_CHANGED', requestId, client);
    });
  }
}
