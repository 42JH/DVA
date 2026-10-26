import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminsService } from '../admins/admins.service';
import { AdminPublic } from '../admins/admins.types';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { AuthRepository } from './auth.repository';
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
}
