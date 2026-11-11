import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  customerPreparationId,
  validateCreatedCustomer,
  validateCustomerCreationReceipt,
  type CreatedOrderCustomer,
  type CustomerCreationReceipt,
  type CustomerPreparationOutcome,
} from '@dva/events/order-customer-write.cjs';
import { requestWriteReference } from '@dva/events/parcel-draft-write.cjs';
import { OrderReadError } from '@dva/events/order-read.cjs';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import { OrderRecipientPinsService } from './order-recipient-pins.service';
import type { Customer } from './customers.types';

type Preparation = { writeEventId: string; customer: CreatedOrderCustomer };
const PHONE_LOCK = 20261113;
const columns =
  'customer_seq AS "customerSeq",name,phone_number AS "phoneNumber",status,monthly_billing_enabled AS "monthlyBillingEnabled",address_data AS address';

@Injectable()
export class OrderCustomerWritesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderCustomerWritesService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
    private readonly recipientPins: OrderRecipientPinsService,
  ) {}

  onModuleInit() {
    if (this.config.get('NODE_ENV') === 'test') return;
    this.timer = setInterval(() => {
      void this.run().catch(() =>
        this.logger.error({ event: 'order_customer_recovery_unavailable' }),
      );
    }, 250);
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running?.catch(() => {});
  }

  async lockPhones(client: PoolClient, phones: string[], writeEventId?: string) {
    for (const phone of [...new Set(phones)].sort()) {
      await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [PHONE_LOCK, phone]);
      await this.resolvePhone(client, phone, writeEventId);
    }
  }

  async prepare(
    client: PoolClient,
    input: { customerSeq?: number; customer?: { name: string; phoneNumber: string } },
    adminId: number | null,
    requestId: string,
    writeEventId: string,
  ): Promise<{ customer: Customer; created: CreatedOrderCustomer | null }> {
    let created: CreatedOrderCustomer | null = null;
    if (input.customer) {
      await this.lockPhones(client, [input.customer.phoneNumber], writeEventId);
      const row = (
        await client.query<Customer>(
          `INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE')
         ON CONFLICT(phone_number) WHERE deleted_at IS NULL DO NOTHING RETURNING ${columns}`,
          [input.customer.name, input.customer.phoneNumber],
        )
      ).rows[0];
      if (row) {
        validateCreatedCustomer(row);
        created = row;
        // This separate connection retains the intent if the owner transaction is lost.
        await this.database.referencePool.query(
          `INSERT INTO outbox_events(event_id,destination,event_type,aggregate_seq,payload)
           VALUES($1,'order','OrderCustomerPreparationRequested',$2,$3)`,
          [
            customerPreparationId(row.phoneNumber),
            row.customerSeq,
            { writeEventId, customer: row },
          ],
        );
        await this.record(client, row.customerSeq, adminId, requestId);
      }
    }
    const customer =
      created ??
      (
        await client.query<Customer>(
          `SELECT ${columns} FROM customers WHERE ${input.customer ? 'phone_number=$1' : 'customer_seq=$1'}
       AND deleted_at IS NULL FOR UPDATE`,
          [input.customer ? input.customer.phoneNumber : input.customerSeq],
        )
      ).rows[0];
    if (!customer) throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    if (customer.status !== 'ACTIVE')
      throw new ApiException(403, 'FORBIDDEN', '주문에는 활성 고객이 필요합니다.');
    return { customer, created };
  }

  private async outcome(writeEventId: string) {
    const url = this.config.get('ORDER_URL', { infer: true });
    try {
      if (!url) throw new Error('Order owner unavailable');
      return await requestWriteReference<CustomerPreparationOutcome>(
        url + '/internal/parcel-draft-write/reference',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'customer',
          eventType: 'ParcelDraftWriteReferenceRequested',
          payload: { operation: 'CustomerPreparationOutcomeRead', input: { writeEventId } },
        },
      );
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  async apply(client: PoolClient, receipt: CustomerCreationReceipt) {
    validateCustomerCreationReceipt(receipt);
    const p = receipt.payload,
      customer = p.customer;
    await client.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [
      PHONE_LOCK,
      customer.phoneNumber,
    ]);
    const inserted = await client.query(
      `INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,'order','OrderCustomerCreated',$2)
       ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [receipt.eventId, p],
    );
    if (!inserted.rowCount) {
      const row = (
        await client.query<{ matches: boolean }>(
          "SELECT source='order' AND event_type='OrderCustomerCreated' AND payload=$2::jsonb AS matches FROM inbox_events WHERE event_id=$1",
          [receipt.eventId, p],
        )
      ).rows[0];
      if (!row?.matches)
        throw new ApiException(
          409,
          'EVENT_PAYLOAD_CONFLICT',
          '같은 이벤트의 내용을 변경할 수 없습니다.',
        );
      return 'duplicate' as const;
    }
    const restored = await client.query(
      `INSERT INTO customers(customer_seq,name,phone_number,status,monthly_billing_enabled,address_data)
       OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,'ACTIVE',false,NULL)
       ON CONFLICT DO NOTHING RETURNING customer_seq`,
      [customer.customerSeq, customer.name, customer.phoneNumber],
    );
    if (restored.rowCount) await this.record(client, customer.customerSeq, p.adminId, p.requestId);
    else {
      const row = await client.query(
        'SELECT 1 FROM customers WHERE customer_seq=$1 AND phone_number=$2 AND deleted_at IS NULL',
        [customer.customerSeq, customer.phoneNumber],
      );
      if (!row.rowCount)
        throw new ApiException(409, 'INVALID_STATE', '주문 고객 저장 상태가 변경되었습니다.');
    }
    await client.query(
      "DELETE FROM outbox_events WHERE event_id=$1 AND destination='order' AND event_type='OrderCustomerPreparationRequested' AND payload->>'writeEventId'=$2",
      [customerPreparationId(customer.phoneNumber), p.writeEventId],
    );
    return 'processed' as const;
  }

  async resolveWrite(
    client: PoolClient,
    writeEventId: string,
    expected?: { eventId: string; customerSeq: number },
  ) {
    const outcome = await this.outcome(writeEventId);
    if (outcome.status !== 'COMMITTED')
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '주문 고객 저장 결과를 확인할 수 없습니다.',
      );
    if (
      expected &&
      (outcome.customerCreationReceipt.eventId !== expected.eventId ||
        outcome.customerCreationReceipt.payload.customer.customerSeq !== expected.customerSeq)
    )
      throw new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '같은 이벤트의 내용을 변경할 수 없습니다.',
      );
    const status = await this.apply(client, outcome.customerCreationReceipt);
    if (outcome.recipientReceipt) await this.recipientPins.apply(client, outcome.recipientReceipt);
    return { status, receipt: outcome.customerCreationReceipt };
  }

  private async resolvePhone(client: PoolClient, phone: string, writeEventId?: string) {
    const preparation = (
      await client.query<{ payload: Preparation }>(
        "SELECT payload FROM outbox_events WHERE event_id=$1 AND destination='order' AND event_type='OrderCustomerPreparationRequested'",
        [customerPreparationId(phone)],
      )
    ).rows[0]?.payload;
    if (!preparation || preparation.writeEventId === writeEventId) return;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const outcome = await this.outcome(preparation.writeEventId);
      if (outcome.status === 'COMMITTED') {
        await this.apply(client, outcome.customerCreationReceipt);
        if (outcome.recipientReceipt)
          await this.recipientPins.apply(client, outcome.recipientReceipt);
        return;
      }
      if (outcome.status === 'ABORTED') {
        await client.query(
          "DELETE FROM outbox_events WHERE event_id=$1 AND payload->>'writeEventId'=$2",
          [customerPreparationId(phone), preparation.writeEventId],
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ApiException(
      409,
      'REQUEST_IN_PROGRESS',
      '다른 작업의 완료 대기 시간을 초과했습니다. 잠시 후 재시도해 주세요.',
    );
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.recover().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async recover() {
    const rows = await this.database.pool.query<{ eventId: string; payload: Preparation }>(
      `SELECT event_id AS "eventId",payload FROM outbox_events WHERE destination='order'
       AND event_type='OrderCustomerPreparationRequested' AND delivered_at IS NULL
       AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,outbox_seq LIMIT 20`,
    );
    for (const row of rows.rows) {
      try {
        await this.database.transaction(async (client) => {
          const locked = (
            await client.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked',
              [PHONE_LOCK, row.payload.customer.phoneNumber],
            )
          ).rows[0].locked;
          if (!locked) return;
          const outcome = await this.outcome(row.payload.writeEventId);
          if (outcome.status === 'COMMITTED') {
            await this.apply(client, outcome.customerCreationReceipt);
            if (outcome.recipientReceipt)
              await this.recipientPins.apply(client, outcome.recipientReceipt);
          } else if (outcome.status === 'ABORTED')
            await client.query('DELETE FROM outbox_events WHERE event_id=$1', [row.eventId]);
          else
            await client.query(
              "UPDATE outbox_events SET next_attempt_at=clock_timestamp()+interval '1 second' WHERE event_id=$1",
              [row.eventId],
            );
        });
      } catch {
        await this.database.pool.query(
          "UPDATE outbox_events SET next_attempt_at=clock_timestamp()+interval '1 second' WHERE event_id=$1",
          [row.eventId],
        );
      }
    }
  }

  private record(client: PoolClient, id: number, adminId: number | null, requestId: string) {
    return this.audit.recordSuccess(
      {
        actorId: adminId,
        actorType: adminId === null ? 'AI' : 'ADMIN',
        targetId: id,
        targetType: 'CUSTOMER',
        action: 'CUSTOMER_CREATED',
        requestId,
      },
      client,
    );
  }
}
