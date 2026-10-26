import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AdminsRepository } from './admins.repository';
import { publicAdmin } from './admins.types';
import { AdminQueryDto } from './dto/admin-query.dto';
@Injectable()
export class AdminsService {
  constructor(private readonly repository: AdminsRepository) {}
  findForLogin(loginId: string, client: PoolClient) {
    return this.repository.byLogin(loginId, client);
  }
  lockAccounts(ids: number[], client: PoolClient) {
    return this.repository.lock(ids, client);
  }
  async list(query: AdminQueryDto) {
    return (await this.repository.list(query)).map(publicAdmin);
  }
  recordLogin(id: number, client: PoolClient) {
    return this.repository.recordLogin(id, client);
  }
}
