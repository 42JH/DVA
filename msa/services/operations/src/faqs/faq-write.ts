import type { PoolClient } from 'pg';
import { FaqWritePending, retryFaqWrite } from '@dva/events/faq-conversion.cjs';
import type { DatabaseService } from '../database/database.service';

export async function faqConversionPending(
  client: Pick<PoolClient, 'query'>,
  transactionId: string | null = null,
): Promise<boolean> {
  return !!(
    await client.query(
      `SELECT 1 FROM consultation_audit_preparations WHERE NOT aborted AND audit ? '_faqConversion'
     AND transaction_id IS DISTINCT FROM $1::uuid LIMIT 1`,
      [transactionId],
    )
  ).rowCount;
}

export async function lockFaqWrite(
  client: PoolClient,
  transactionId: string | null = null,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(20261110,1)');
  if (await faqConversionPending(client, transactionId)) throw new FaqWritePending();
}

export function faqWrite<T>(
  database: DatabaseService,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return retryFaqWrite(() =>
    database.transaction(async (client) => {
      await lockFaqWrite(client);
      return work(client);
    }),
  );
}
