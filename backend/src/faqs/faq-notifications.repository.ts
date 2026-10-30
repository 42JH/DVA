import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { FaqChange } from './faq-change';

export interface PendingFaqChange extends FaqChange {
  id: number;
  claimId: string;
  requestId: string;
  attempts: number;
}

@Injectable()
export class FaqNotificationsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async claim(): Promise<PendingFaqChange | undefined> {
    return this.database.transaction(async (client) => {
      // 가장 오래된 대기를 먼저 처리하며 재시도·처리 중인 선행 알림을 추월하지 않는다.
      const pending = (
        await client.query<PendingFaqChange>(
          `UPDATE faq_change_notifications SET claim_id=$1,
           claimed_until=clock_timestamp()+interval '30 seconds',attempts=attempts+1
           WHERE faq_change_notification_seq=(SELECT faq_change_notification_seq
             FROM faq_change_notifications WHERE sent_at IS NULL
             ORDER BY faq_change_notification_seq LIMIT 1)
           AND sent_at IS NULL AND next_attempt_at<=clock_timestamp()
           AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
           RETURNING faq_change_notification_seq AS id,event_id AS "eventId",operation,
             faq_entry_seqs AS "faqEntrySeqs",claim_id AS "claimId",request_id AS "requestId",attempts`,
          [randomUUID()],
        )
      ).rows[0];
      if (pending)
        await this.audit.recordSuccess(
          {
            actorId: null,
            actorType: 'SYSTEM',
            targetId: pending.id,
            targetType: 'FAQ_CHANGE_NOTIFICATION',
            action: 'FAQ_NOTIFICATION_ATTEMPTED',
            requestId: pending.requestId,
          },
          client,
        );
      return pending;
    });
  }

  async finish(pending: PendingFaqChange, sent: boolean): Promise<void> {
    const delay = Math.min(300, 5 * 2 ** Math.min(pending.attempts - 1, 6));
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE faq_change_notifications SET claim_id=NULL,claimed_until=NULL,
           sent_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
           next_attempt_at=clock_timestamp()+make_interval(secs=>$4)
         WHERE faq_change_notification_seq=$1 AND claim_id=$2 AND sent_at IS NULL`,
        [pending.id, pending.claimId, sent, delay],
      );
      if (result.rowCount)
        await this.audit.recordResult(
          {
            actorId: null,
            actorType: 'SYSTEM',
            targetId: pending.id,
            targetType: 'FAQ_CHANGE_NOTIFICATION',
            action: sent ? 'FAQ_NOTIFICATION_SENT' : 'FAQ_NOTIFICATION_FAILED',
            requestId: pending.requestId,
          },
          sent ? 'SUCCESS' : 'FAILED',
          client,
        );
    });
  }
}
