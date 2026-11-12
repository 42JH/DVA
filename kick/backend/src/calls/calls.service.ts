import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

type Friend = { id: string; displayName: string };

type Call = {
  id: string;
  callerId: string;
  calleeId: string;
  status: 'REQUESTED';
  requestedAt: Date;
};

const callColumns =
  'id, caller_id AS "callerId", callee_id AS "calleeId", status, requested_at AS "requestedAt"';

@Injectable()
export class CallsService {
  constructor(private readonly database: DatabaseService) {}

  async listFriends(accountId: string): Promise<Friend[]> {
    const { rows } = await this.database.query<Friend>(
      `SELECT users.id, users.display_name AS "displayName"
       FROM friendships JOIN users ON users.id = friendships.friend_id
       WHERE friendships.user_id = $1 ORDER BY users.display_name, users.id`,
      [accountId],
    );
    return rows;
  }

  async requestCall(callerId: string, calleeId: string, requestId: string): Promise<Call> {
    const created = await this.database.query<Call>(
      `INSERT INTO calls (caller_id, callee_id, request_id)
       SELECT user_id, friend_id, $3::uuid FROM friendships WHERE user_id = $1 AND friend_id = $2
       ON CONFLICT (caller_id, request_id) DO NOTHING RETURNING ${callColumns}`,
      [callerId, calleeId, requestId],
    );
    if (created.rows[0]) {
      return created.rows[0];
    }

    const {
      rows: [existing],
    } = await this.database.query<Call>(
      `SELECT ${callColumns} FROM calls WHERE caller_id = $1 AND request_id = $2`,
      [callerId, requestId],
    );
    if (!existing) {
      throw new NotFoundException('Friend not found');
    }
    if (existing.calleeId !== calleeId) {
      throw new ConflictException('requestId was already used for a different recipient');
    }
    return existing;
  }
}
