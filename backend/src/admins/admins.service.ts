import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AdminsRepository } from './admins.repository';
@Injectable()
export class AdminsService {
  constructor(private readonly repository: AdminsRepository) {}
  lockAccounts(ids: number[], client: PoolClient) {
    return this.repository.lock(ids, client);
  }
}
