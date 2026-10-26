import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AdminPublic } from '../admins/admins.types';
@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}
  async find(hash: string, client?: PoolClient) {
    return (
      await (client ?? this.database.pool).query<AdminPublic>(
        `SELECT a.admin_user_seq AS "adminUserSeq",
   a.login_id AS "loginId",a.name,a.role,a.status,a.created_at AS "createdAt",a.last_login_at AS "lastLoginAt"
   FROM admin_sessions s JOIN admin_users a USING(admin_user_seq)
   WHERE s.session_token_hash=$1 AND s.expires_at>clock_timestamp() AND a.status='ACTIVE'`,
        [hash],
      )
    ).rows[0];
  }
  async create(hash: string, id: number, client: PoolClient): Promise<Date> {
    const row = (
      await client.query(
        `INSERT INTO admin_sessions(session_token_hash,admin_user_seq,created_at,expires_at)
   VALUES($1,$2,statement_timestamp(),statement_timestamp()+INTERVAL '9 hours') RETURNING expires_at`,
        [hash, id],
      )
    ).rows[0];
    return row.expires_at;
  }
  async remove(hash: string, client?: PoolClient) {
    await (client ?? this.database.pool).query(
      'DELETE FROM admin_sessions WHERE session_token_hash=$1',
      [hash],
    );
  }
  async removeAll(id: number, client: PoolClient) {
    await client.query('DELETE FROM admin_sessions WHERE admin_user_seq=$1', [id]);
  }
  async removeExpired(id: number, client: PoolClient) {
    await client.query(
      'DELETE FROM admin_sessions WHERE admin_user_seq=$1 AND expires_at<=clock_timestamp()',
      [id],
    );
  }
}
