import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminAccount } from './admins.types';
const columns = `admin_user_seq AS "adminUserSeq", login_id AS "loginId", name, role, status,
 created_at AS "createdAt", last_login_at AS "lastLoginAt", password_hash AS "passwordHash"`;
@Injectable()
export class AdminsRepository {
  constructor(private readonly database: DatabaseService) {}
  async lock(ids: number[], client: PoolClient) {
    return (
      await client.query<AdminAccount>(
        `SELECT ${columns} FROM admin_users WHERE admin_user_seq=ANY($1::int[]) ORDER BY admin_user_seq FOR UPDATE`,
        [ids],
      )
    ).rows;
  }
}
