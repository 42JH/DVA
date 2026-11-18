import type { PoolClient } from 'pg';
import {
  validateFaqConversionPayload,
  type FaqConversionPayload,
} from '@dva/events/faq-conversion.cjs';
import type { AuditRepository } from '../audit/audit.repository';
import { queueFaqChange } from './faq-change';
import { lockFaqWrite } from './faq-write';

interface PreparedRows {
  faq: Record<string, unknown> & FaqConversionPayload['faq'] & { faq_entry_seq: number };
  audit: Record<string, unknown>;
  notification: Record<string, unknown>;
}
type Preparation = { _faqConversion: FaqConversionPayload & PreparedRows };
export const isFaqConversionPreparation = (value: unknown): value is Preparation =>
  value !== null && typeof value === 'object' && Object.hasOwn(value, '_faqConversion');

export async function prepareFaqConversion(
  client: PoolClient,
  input: FaqConversionPayload,
  audit: AuditRepository,
): Promise<Preparation> {
  validateFaqConversionPayload(input);
  await lockFaqWrite(client, input.transactionId);
  await client.query('SAVEPOINT faq_conversion');
  try {
    const id = (
      await client.query<{ id: number }>(
        'INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,category) VALUES($1,$2,$3,$4) RETURNING faq_entry_seq AS id',
        [input.faq.question, input.faq.answer, input.adminId, input.faq.category],
      )
    ).rows[0].id;
    await audit.insert(
      {
        actorId: input.adminId,
        action: 'FAQ_CREATED',
        targetType: 'FAQ_ENTRY',
        targetId: id,
        requestId: input.requestId,
      },
      'SUCCESS',
      client,
    );
    await queueFaqChange(client, 'INSERT', [id], input.requestId);
    const rows = (
      await client.query<{ data: PreparedRows }>(
        `SELECT jsonb_build_object('faq',(SELECT to_jsonb(f) FROM faq_entries f WHERE faq_entry_seq=$1),
       'audit',(SELECT to_jsonb(a) FROM audit_logs a WHERE audit_log_seq=currval(pg_get_serial_sequence('audit_logs','audit_log_seq'))),
       'notification',(SELECT to_jsonb(n) FROM faq_change_notifications n WHERE faq_change_notification_seq=currval(pg_get_serial_sequence('faq_change_notifications','faq_change_notification_seq')))) AS data`,
        [id],
      )
    ).rows[0].data;
    await client.query('ROLLBACK TO SAVEPOINT faq_conversion');
    return { _faqConversion: { ...input, ...rows } };
  } catch (error: unknown) {
    await client.query('ROLLBACK TO SAVEPOINT faq_conversion');
    throw error;
  } finally {
    await client.query('RELEASE SAVEPOINT faq_conversion');
  }
}

export async function commitFaqConversion(
  client: PoolClient,
  prepared: Preparation,
  transactionId: string,
): Promise<void> {
  const input = prepared._faqConversion;
  validateFaqConversionPayload({
    transactionId: input.transactionId,
    requestId: input.requestId,
    adminId: input.adminId,
    faq: {
      question: input.faq.question,
      answer: input.faq.answer,
      category: input.faq.category,
    },
  });
  if (input.transactionId !== transactionId) throw new Error('Invalid FAQ conversion transaction');
  await lockFaqWrite(client, transactionId);
  await client.query(
    'INSERT INTO faq_entries OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::faq_entries,$1::jsonb)).*',
    [JSON.stringify(input.faq)],
  );
  await client.query(
    'INSERT INTO audit_logs OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::audit_logs,$1::jsonb)).*',
    [JSON.stringify(input.audit)],
  );
  await client.query(
    'INSERT INTO faq_change_notifications OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::faq_change_notifications,$1::jsonb)).*',
    [JSON.stringify(input.notification)],
  );
}
