import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class RetentionRepository {
  constructor(private readonly database: DatabaseService) {}

  async purgeDatabase(): Promise<void> {
    await this.database.transaction(async (client) => {
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261103,157) AS locked',
          )
        ).rows[0].locked
      )
        return;
      if (
        !(
          await client.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_xact_lock(20261027,37) AS locked',
          )
        ).rows[0].locked
      )
        return;
      await client.query("SET LOCAL lock_timeout='1s'");
      await client.query(`DELETE FROM audit_logs WHERE audit_log_seq IN (SELECT audit_log_seq FROM audit_logs
        WHERE occurred_at<=statement_timestamp()-interval '7 days' ORDER BY occurred_at,audit_log_seq LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM faq_change_notifications WHERE faq_change_notification_seq IN (
        SELECT faq_change_notification_seq FROM faq_change_notifications WHERE sent_at<=statement_timestamp()-interval '7 days'
        ORDER BY sent_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
      await client.query(`UPDATE ai_persona_versions SET created_by_admin_user_name=NULL WHERE ai_persona_version_seq IN (
        SELECT ai_persona_version_seq FROM ai_persona_versions WHERE created_at<=statement_timestamp()-interval '5 years'
         AND created_by_admin_user_name IS NOT NULL LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM admin_users WHERE admin_user_seq IN (SELECT admin_user_seq FROM admin_users
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM faq_entries WHERE faq_entry_seq IN (SELECT faq_entry_seq FROM faq_entries
        WHERE deleted_at<=statement_timestamp()-interval '5 years' LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      await client.query(`DELETE FROM faq_question_examples WHERE faq_question_example_seq IN (
        SELECT faq_question_example_seq FROM faq_question_examples
        WHERE occurred_at<=statement_timestamp()-interval '5 years'
        ORDER BY occurred_at,faq_question_example_seq LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    });
  }
}
