import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AdminsRepository } from './admins.repository';
@Injectable()
export class AdminsService {
  constructor(private readonly repository: AdminsRepository) {}
  findForLogin(loginId: string, client: PoolClient) {
    return this.repository.byLogin(loginId, client);
  }
  lockAccounts(ids: number[], client: PoolClient) {
    return this.repository.lock(ids, client);
  }
  recordLogin(id: number, client: PoolClient) {
    return this.repository.recordLogin(id, client);
  }
}
