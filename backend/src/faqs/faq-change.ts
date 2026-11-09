import { PoolClient } from 'pg';

export interface FaqChange {
  eventId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  faqEntrySeqs: number[];
}

export async function queueFaqChange(
  client: PoolClient,
  operation: FaqChange['operation'],
  ids: number[],
  requestId: string,
): Promise<void> {
  await client.query(
    'INSERT INTO faq_change_notifications(operation,faq_entry_seqs,request_id) VALUES($1,$2,$3)',
    [operation, ids, requestId],
  );
}
