import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminsService } from '../admins/admins.service';
import { AdminAccount, AdminPublic } from '../admins/admins.types';
import { UpdateAdminDto } from '../admins/dto/admin-query.dto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { AuthRepository } from './auth.repository';
import { ChangePasswordDto, LoginDto, SignupDto } from './dto/auth-request.dto';
import { hashPassword, verifyPassword } from './password';
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
  async signup(input: SignupDto, requestId: string) {
    const hash = await hashPassword(input.password);
    await this.database.transaction(async (client) => {
      const account = await this.admins.signup(input.loginId, input.name, hash, client);
      await this.audit.record(null, account.adminUserSeq, 'ADMIN_SIGNUP', requestId, client);
    });
  }
  async logout(token: string | undefined, requestId: string) {
    if (!token) return;
    try {
      await this.database.transaction(async (client) => {
        const account = await this.repository.find(tokenHash(token), client);
        await this.repository.remove(tokenHash(token), client);
        if (account)
          await this.audit.record(
            account.adminUserSeq,
            account.adminUserSeq,
            'ADMIN_LOGOUT',
            requestId,
            client,
          );
      });
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
      await this.admins.serializeAccessChanges(client);
      const { actor, target } = await this.lockAuthorized(token, id, true, client);
      await this.admins.updateAccess(target, input, client);
      await this.audit.record(actor.adminUserSeq, id, 'ADMIN_ACCESS_CHANGED', requestId, client);
    });
  }
  async deleteAdmin(token: string, id: number, requestId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.admins.serializeAccessChanges(client);
      const { actor, target } = await this.lockAuthorized(token, id, true, client);
      if (target.role === 'SYSTEM_ADMIN')
        throw new ApiException(403, 'FORBIDDEN', '최상위 관리자는 삭제할 수 없습니다.');
      // 계정이 존재할 때 이름을 기록하며, 삭제 실패 시 감사와 세션 삭제도 함께 롤백한다.
      await this.audit.record(actor.adminUserSeq, id, 'ADMIN_DELETED', requestId, client);
      await this.admins.remove(id, client);
    });
  }
  private async savePassword(
    actor: AdminPublic,
    target: AdminAccount,
    hash: string,
    requestId: string,
    client: PoolClient,
  ) {
    await this.admins.setPassword(target.adminUserSeq, hash, client);
    await this.repository.removeAll(target.adminUserSeq, client);
    await this.audit.record(
      actor.adminUserSeq,
      target.adminUserSeq,
      'ADMIN_PASSWORD_CHANGED',
      requestId,
      client,
    );
  }
  async changePassword(token: string, input: ChangePasswordDto, requestId: string) {
    const details = [];
    if ([...input.newPassword].length < 6)
      details.push({ field: 'newPassword', reason: 'PASSWORD_POLICY_VIOLATION' });
    if (input.newPassword !== input.newPasswordConfirm)
      details.push({ field: 'newPasswordConfirm', reason: 'PASSWORD_MISMATCH' });
    if (details.length)
      throw new ApiException(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', details);
    const hash = await hashPassword(input.newPassword);
    await this.database.transaction(async (client) => {
      const identity = await this.authenticate(token, client);
      const { actor, target } = await this.lockAuthorized(
        token,
        identity.adminUserSeq,
        false,
        client,
      );
      if (!(await verifyPassword(input.currentPassword, target.passwordHash)))
        throw new ApiException(422, 'VALIDATION_FAILED', '입력값을 확인해 주세요.', [
          { field: 'currentPassword', reason: 'INCORRECT_PASSWORD' },
        ]);
      await this.savePassword(actor, target, hash, requestId, client);
    });
  }
  async resetPassword(token: string, id: number, requestId: string) {
    const hash = await hashPassword('dva1234');
    return this.database.transaction(async (client) => {
      const { actor, target } = await this.lockAuthorized(token, id, true, client);
      await this.savePassword(actor, target, hash, requestId, client);
      return actor.adminUserSeq === id;
    });
  }
}
