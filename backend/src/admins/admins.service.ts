import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { AdminsRepository } from './admins.repository';
import { AdminAccount, ASSIGNABLE_ADMIN_ROLES, publicAdmin } from './admins.types';
import { AdminQueryDto, UpdateAdminDto } from './dto/admin-query.dto';
@Injectable()
export class AdminsService {
  constructor(private readonly repository: AdminsRepository) {}
  findForLogin(loginId: string, client: PoolClient) {
    return this.repository.byLogin(loginId, client);
  }
  lockAccounts(ids: number[], client: PoolClient) {
    return this.repository.lock(ids, client);
  }
  async signup(loginId: string, name: string, hash: string, client: PoolClient) {
    try {
      return await this.repository.create(loginId, name, hash, client);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        throw new ApiException(409, 'SIGNUP_UNAVAILABLE', '가입 신청을 처리할 수 없습니다.');
      throw error;
    }
  }
  async list(query: AdminQueryDto) {
    return (await this.repository.list(query)).map(publicAdmin);
  }
  serializeAccessChanges(client: PoolClient) {
    return this.repository.serializeAccessChanges(client);
  }
  async updateAccess(target: AdminAccount, input: UpdateAdminDto, client: PoolClient) {
    if (input.role === undefined && input.status === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '변경할 항목이 필요합니다.');
    if (input.status !== undefined && !(target.status === 'PENDING' && input.status === 'ACTIVE'))
      throw new ApiException(409, 'INVALID_STATE', '가입 대기 계정만 승인할 수 있습니다.');
    const role = input.role ?? target.role;
    const status = input.status ?? target.status;
    if (
      input.role !== undefined &&
      (target.role === 'SYSTEM_ADMIN' || !ASSIGNABLE_ADMIN_ROLES.includes(input.role))
    )
      throw new ApiException(
        403,
        'FORBIDDEN',
        'OPERATOR와 SUPERVISOR 사이에서만 권한을 변경할 수 있습니다.',
      );
    await this.repository.setAccess(target.adminUserSeq, role, status, client);
  }
  setPassword(id: number, hash: string, client: PoolClient) {
    return this.repository.setPassword(id, hash, client);
  }
  recordLogin(id: number, client: PoolClient) {
    return this.repository.recordLogin(id, client);
  }
  remove(id: number, client: PoolClient) {
    return this.repository.remove(id, client);
  }
}
