import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  validateRecipientReceipt,
  type RecipientAddress,
  type RecipientPin,
  type RecipientReceipt,
} from '@dva/events/order-recipient-pins.cjs';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';

@Injectable()
export class OrderRecipientPinsService {
  constructor(private readonly audit: AuditService) {}

  async prepare(
    client: PoolClient,
    customerId: number,
    addresses: RecipientAddress[],
    adminId: number | null,
    requestId: string,
    writeEventId: string,
  ): Promise<RecipientPin[]> {
    await client.query('SELECT pg_advisory_xact_lock(20261111,hashtext($1))', [writeEventId]);
    const pins = (
      await client.query<RecipientPin>(
        `INSERT INTO personal_pins(customer_seq,label,address_data)
         SELECT $1,address->>'name',address FROM jsonb_array_elements($2::jsonb) address
         ORDER BY pin_identity(address)
         ON CONFLICT(customer_seq,pin_identity(address_data)) WHERE deleted_at IS NULL DO NOTHING
         RETURNING personal_pin_seq AS "personalPinSeq",label,address_data AS address`,
        [customerId, JSON.stringify(addresses)],
      )
    ).rows;
    for (const pin of pins) await this.record(client, pin.personalPinSeq, adminId, requestId);
    return pins;
  }

  async apply(client: PoolClient, receipt: RecipientReceipt) {
    validateRecipientReceipt(receipt);
    const p = receipt.payload;
    // Recovery waits for this preparation before acquiring its receipt row.
    await client.query('SELECT pg_advisory_xact_lock(20261111,hashtext($1))', [p.writeEventId]);
    const inserted = await client.query(
      `INSERT INTO inbox_events(event_id,source,event_type,payload)
       VALUES($1,'order','OrderRecipientPinsWritten',$2)
       ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [receipt.eventId, p],
    );
    if (!inserted.rowCount) {
      const existing = (
        await client.query<{ matches: boolean }>(
          `SELECT source='order' AND event_type='OrderRecipientPinsWritten' AND payload=$2::jsonb AS matches
           FROM inbox_events WHERE event_id=$1`,
          [receipt.eventId, p],
        )
      ).rows[0];
      if (!existing?.matches)
        throw new ApiException(
          409,
          'EVENT_PAYLOAD_CONFLICT',
          '같은 이벤트의 내용을 변경할 수 없습니다.',
        );
      return 'duplicate' as const;
    }
    for (const pin of p.pins) {
      const saved = await client.query(
        `INSERT INTO personal_pins(personal_pin_seq,customer_seq,label,address_data)
         OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING personal_pin_seq`,
        [pin.personalPinSeq, p.customerSeq, pin.label, pin.address],
      );
      if (saved.rowCount) {
        await this.record(client, pin.personalPinSeq, p.adminId, p.requestId);
        continue;
      }
      const existing = await client.query(
        `SELECT 1 FROM personal_pins WHERE customer_seq=$1
         AND pin_identity(address_data)=pin_identity($2::jsonb) AND deleted_at IS NULL`,
        [p.customerSeq, pin.address],
      );
      if (!existing.rowCount)
        throw new ApiException(409, 'INVALID_STATE', '수령인 PIN 저장 상태가 변경되었습니다.');
    }
    return 'processed' as const;
  }

  private record(client: PoolClient, id: number, adminId: number | null, requestId: string) {
    return this.audit.recordSuccess(
      {
        actorId: adminId,
        actorType: adminId === null ? 'AI' : 'ADMIN',
        targetId: id,
        targetType: 'PERSONAL_PIN',
        action: 'PERSONAL_PIN_CREATED',
        requestId,
      },
      client,
    );
  }
}
