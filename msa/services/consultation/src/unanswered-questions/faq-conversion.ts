import type { PoolClient } from 'pg';
import { FaqWritePending } from '@dva/events/faq-conversion.cjs';

export async function ensureFaqConversionsConfirmed(
  client: PoolClient,
): Promise<void> {
  // The question update and this intent share one snapshot; retry outside the connection until the FAQ owner confirms.
  if (
    (
      await client.query(
        "SELECT 1 FROM outbox_events WHERE destination='operations' AND event_type='FaqConversionCommitted' AND delivered_at IS NULL LIMIT 1",
      )
    ).rowCount
  )
    throw new FaqWritePending();
}
