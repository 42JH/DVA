import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { CallPushService } from './call-push.service';

type Friend = { id: string; displayName: string };
type CallStatus = 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELED' | 'ENDED' | 'EXPIRED';
export type CallAction = 'accept' | 'reject' | 'cancel' | 'end';

type Call = {
  id: string;
  callerId: string;
  calleeId: string;
  status: CallStatus;
  requestedAt: Date;
};

const callColumns =
  'id, caller_id AS "callerId", callee_id AS "calleeId", status, requested_at AS "requestedAt"';
const transitions = {
  accept: { from: 'REQUESTED', to: 'ACCEPTED', role: 'callee' },
  reject: { from: 'REQUESTED', to: 'REJECTED', role: 'callee' },
  cancel: { from: 'REQUESTED', to: 'CANCELED', role: 'caller' },
  end: { from: 'ACCEPTED', to: 'ENDED', role: 'either' },
} as const;

@Injectable()
export class CallsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly push: CallPushService,
  ) {}

  async listFriends(accountId: string): Promise<Friend[]> {
    const { rows } = await this.database.query<Friend>(
      `SELECT users.id, users.display_name AS "displayName"
       FROM friendships JOIN users ON users.id = friendships.friend_id
       WHERE friendships.user_id = $1 ORDER BY users.display_name, users.id`,
      [accountId],
    );
    return rows;
  }

  async addFriend(accountId: string, friendId: string): Promise<Friend> {
    if (friendId === accountId) {
      throw new BadRequestException('Cannot add yourself');
    }
    const { rows } = await this.database.query<Friend>(
      `WITH friend AS (
         SELECT id, display_name FROM users WHERE id = $2
       ), added AS (
         INSERT INTO friendships (user_id, friend_id) SELECT $1, id FROM friend
         ON CONFLICT (user_id, friend_id) DO NOTHING
       )
       SELECT id, display_name AS "displayName" FROM friend`,
      [accountId, friendId],
    );
    if (!rows[0]) {
      throw new NotFoundException('Account not found');
    }
    return rows[0];
  }

  private async expire(accountId: string): Promise<void> {
    await this.database.query(
      `UPDATE calls SET status = 'EXPIRED'
       WHERE (caller_id = $1 OR callee_id = $1) AND (
         (status = 'REQUESTED' AND requested_at <= now() - interval '60 seconds') OR
         (status = 'ACCEPTED' AND accepted_at <= now() - interval '2 hours')
       )`,
      [accountId],
    );
  }

  async activeCall(accountId: string): Promise<{ accountId: string; call: Call | null }> {
    await this.expire(accountId);
    const { rows } = await this.database.query<Call>(
      `SELECT ${callColumns} FROM calls
       WHERE (caller_id = $1 OR callee_id = $1) AND status IN ('REQUESTED', 'ACCEPTED')
       ORDER BY requested_at DESC LIMIT 1`,
      [accountId],
    );
    return { accountId, call: rows[0] ?? null };
  }

  private async find(accountId: string, id: string): Promise<Call> {
    const { rows } = await this.database.query<Call>(
      `SELECT ${callColumns} FROM calls WHERE id = $2 AND (caller_id = $1 OR callee_id = $1)`,
      [accountId, id],
    );
    if (!rows[0]) {
      throw new NotFoundException('Call not found');
    }
    return rows[0];
  }

  async getCall(accountId: string, id: string): Promise<Call> {
    await this.expire(accountId);
    return this.find(accountId, id);
  }

  async transition(accountId: string, id: string, action: CallAction): Promise<Call> {
    await this.expire(accountId);
    const { from, to, role } = transitions[action];
    const { rows } = await this.database.query<Call>(
      `UPDATE calls SET status = $3, accepted_at = CASE WHEN $3 = 'ACCEPTED' THEN now() ELSE accepted_at END
       WHERE id = $2 AND status = $4 AND (
         ($5 <> 'callee' AND caller_id = $1) OR ($5 <> 'caller' AND callee_id = $1)
       ) AND (
         ($4 = 'REQUESTED' AND requested_at > now() - interval '60 seconds') OR
         ($4 = 'ACCEPTED' AND accepted_at > now() - interval '2 hours')
       )
       RETURNING ${callColumns}`,
      [accountId, id, to, from, role],
    );
    if (rows[0]) {
      return rows[0];
    }
    const call = await this.find(accountId, id);
    if (
      (role === 'caller' && call.callerId !== accountId) ||
      (role === 'callee' && call.calleeId !== accountId)
    ) {
      throw new NotFoundException('Call not found');
    }
    if (call.status === to) {
      return call;
    }
    throw new ConflictException('Call state does not allow this action');
  }

  async requestCall(callerId: string, calleeId: string, requestId: string): Promise<Call> {
    await this.expire(callerId);
    const created = await this.database.query<Call>(
      `INSERT INTO calls (caller_id, callee_id, request_id)
       SELECT user_id, friend_id, $3::uuid FROM friendships WHERE user_id = $1 AND friend_id = $2
       ON CONFLICT DO NOTHING RETURNING ${callColumns}`,
      [callerId, calleeId, requestId],
    );
    if (created.rows[0]) {
      // shortcut: send after saving the call; add a durable queue if notifications must survive process restarts.
      void this.push.incoming(created.rows[0]);
      return created.rows[0];
    }

    const {
      rows: [existing],
    } = await this.database.query<Call>(
      `SELECT ${callColumns} FROM calls WHERE caller_id = $1 AND request_id = $2`,
      [callerId, requestId],
    );
    if (existing) {
      if (existing.calleeId !== calleeId) {
        throw new ConflictException('requestId was already used for a different recipient');
      }
      return existing;
    }

    const friend = await this.database.query(
      'SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2',
      [callerId, calleeId],
    );
    if (!friend.rowCount) {
      throw new NotFoundException('Friend not found');
    }
    throw new ConflictException('A call between these accounts is already active');
  }
}
