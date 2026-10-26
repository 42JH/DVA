import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminAccount, AdminRole, AdminStatus } from './admins.types';
import { AdminQueryDto } from './dto/admin-query.dto';
const columns = `admin_user_seq AS "adminUserSeq", login_id AS "loginId", name, role, status,
 created_at AS "createdAt", last_login_at AS "lastLoginAt", password_hash AS "passwordHash"`;
@Injectable()
export class AdminsRepository {
  constructor(private readonly database: DatabaseService) {}
  async byLogin(loginId: string, client: PoolClient) {
    return (
      await client.query<AdminAccount>(
        `SELECT ${columns} FROM admin_users WHERE login_id=$1 FOR UPDATE`,
        [loginId],
      )
    ).rows[0];
  }
  async lock(ids: number[], client: PoolClient) {
    return (
      await client.query<AdminAccount>(
        `SELECT ${columns} FROM admin_users WHERE admin_user_seq=ANY($1::int[]) ORDER BY admin_user_seq FOR UPDATE`,
        [ids],
      )
    ).rows;
  }
  async create(loginId: string, name: string, hash: string, client: PoolClient) {
    return (
      await client.query<AdminAccount>(
        `INSERT INTO admin_users(login_id,name,password_hash,role,status)
   VALUES($1,$2,$3,'OPERATOR','PENDING') RETURNING ${columns}`,
        [loginId, name, hash],
      )
    ).rows[0];
  }
  async list(query: AdminQueryDto) {
    return (
      await this.database.pool.query<AdminAccount>(
        `SELECT ${columns} FROM admin_users
   WHERE ($1::text IS NULL OR role=$1) AND ($2::text IS NULL OR status=$2)
   ORDER BY admin_user_seq DESC LIMIT $3 OFFSET $4`,
        [query.role ?? null, query.status ?? null, query.limit + 1, query.offset],
      )
    ).rows;
  }
  async setAccess(id: number, role: AdminRole, status: AdminStatus, client: PoolClient) {
    await client.query('UPDATE admin_users SET role=$2,status=$3 WHERE admin_user_seq=$1', [
      id,
      role,
      status,
    ]);
  }
  async activeSystemAdmins(client: PoolClient): Promise<number> {
    return Number(
      (
        await client.query(
          "SELECT count(*) FROM admin_users WHERE role='SYSTEM_ADMIN' AND status='ACTIVE'",
        )
      ).rows[0].count,
    );
  }
  async serializeAccessChanges(client: PoolClient) {
    await client.query('SELECT pg_advisory_xact_lock(20261026,83)');
  }
  async setPassword(id: number, hash: string, client: PoolClient) {
    await client.query('UPDATE admin_users SET password_hash=$2 WHERE admin_user_seq=$1', [
      id,
      hash,
    ]);
  }
  async recordLogin(id: number, client: PoolClient) {
    await client.query(
      'UPDATE admin_users SET last_login_at=clock_timestamp() WHERE admin_user_seq=$1',
      [id],
    );
  }
}
