import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { enqueue } from '@dva/events';
import { commandHash } from '@dva/events/call-scope.cjs';
import { OrderReadError } from '@dva/events/order-read.cjs';
import { readCallbackUrl } from '@dva/events/read-scope.cjs';
import { requestDraftCallReferences } from '@dva/events/parcel-drafts.cjs';
import {
  requestDraftWrite,
  requestWriteReference,
  type OwnerCallWriteReceipt,
  type CallOrderLink,
  type CustomerReference,
  type DraftWriteCall,
  type DraftWriteCommand,
  type DraftWriteEvent,
  type DraftWriteResult,
  type WriteReferenceEvent,
} from '@dva/events/parcel-draft-write.cjs';
import { AuditService } from '../audit/audit.service';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type {
  IntakeCall,
  IntakeCompletion,
  PaymentPolicy,
} from '@dva/events/order-intake-write.cjs';
import { writeOrder } from './order-write';

type ActiveWrite = {
  event: DraftWriteEvent;
  before: Pick<DraftWriteCall, 'callSessionSeq' | 'customerSeq' | 'intakeVersion'> | null;
  call: DraftWriteCall | null;
  receipt: OwnerCallWriteReceipt | null;
  link: CallOrderLink | null;
};

@Injectable()
export class ParcelDraftWriteScope {
  private readonly local = new AsyncLocalStorage<ActiveWrite>();

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
  ) {}

  async request(command: DraftWriteCommand): Promise<Record<string, unknown>> {
    try {
      const result = await requestDraftWrite(
        this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/parcel-draft-write',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'ParcelDraftWriteRequested',
          payload: {
            command,
            orderAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
          },
        },
      );
      return result.data;
    } catch (error) {
      this.failure(error);
    }
  }

  run(
    event: DraftWriteEvent,
    work: () => Promise<Record<string, unknown>>,
  ): Promise<DraftWriteResult> {
    const call = event.payload.call ?? null;
    const state: ActiveWrite = {
      event,
      before: call && { ...call },
      call: null,
      receipt: null,
      link: null,
    };
    return this.local.run(state, async () => ({ data: await work(), receipt: state.receipt }));
  }

  private get active(): ActiveWrite {
    const state = this.local.getStore();
    if (!state) throw new Error('Draft write scope is not held');
    return state;
  }

  async transaction<T extends Record<string, unknown>>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const state = this.active;
    const event = state.event;
    const command = event.payload.command;
    if (command.operation === 'OrderIntakeSealed') return writeOrder(this.database, work);
    const hash = commandHash(
      command.operation === 'OrderIntakeFinalized' ? { ...command, requestId: '' } : command,
    );
    let replay = false;
    const result = await writeOrder(this.database, async (client) => {
      const inserted = await client.query(
        'INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING RETURNING event_id',
        [event.eventId, event.source, event.eventType, { requestHash: hash }],
      );
      if (!inserted.rowCount) {
        const existing = (
          await client.query<{
            source: string;
            event_type: string;
            payload: { requestHash: string; result: DraftWriteResult };
          }>('SELECT source,event_type,payload FROM inbox_events WHERE event_id=$1', [
            event.eventId,
          ])
        ).rows[0];
        if (
          existing.source !== event.source ||
          existing.event_type !== event.eventType ||
          existing.payload.requestHash !== hash
        )
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '같은 이벤트의 내용을 변경할 수 없습니다.',
          );
        replay = true;
        state.receipt = existing.payload.result.receipt;
        return existing.payload.result.data as T;
      }
      const data = await work(client);
      if (command.operation === 'OrderIntakeFinalized' && data.finalization === null) {
        await client.query('DELETE FROM inbox_events WHERE event_id=$1', [event.eventId]);
        return data;
      }
      if (state.link) {
        const eventId = await enqueue(client, {
          destination: 'consultation',
          eventType: 'OrderCallLinked',
          aggregateSeq: state.link.callSessionSeq,
          payload: { ...state.link },
        });
        state.receipt = { eventId, payload: state.link };
      } else if (
        state.before &&
        state.call &&
        (state.before.customerSeq !== state.call.customerSeq ||
          state.before.intakeVersion !== state.call.intakeVersion)
      ) {
        const payload = {
          callSessionSeq: state.call.callSessionSeq,
          beforeVersion: state.before.intakeVersion,
          afterVersion: state.call.intakeVersion,
          customerSeq: state.call.customerSeq,
        };
        const eventId = await enqueue(client, {
          destination: 'consultation',
          eventType: 'ParcelDraftCallWritten',
          aggregateSeq: payload.callSessionSeq,
          payload,
        });
        state.receipt = { eventId, payload };
      }
      await client.query('UPDATE inbox_events SET payload=payload || $2::jsonb WHERE event_id=$1', [
        event.eventId,
        JSON.stringify({ result: { data, receipt: state.receipt } }),
      ]);
      return data;
    });
    if (replay) await this.audit.flush();
    return result;
  }

  private reference<T>(
    owner: 'customer' | 'consultation',
    operation: WriteReferenceEvent['payload']['operation'],
    input: Record<string, unknown>,
  ): Promise<T> {
    const event = this.active.event;
    return requestWriteReference<T>(
      readCallbackUrl(
        this.config.get(owner === 'customer' ? 'CUSTOMER_URL' : 'CONSULTATION_URL', {
          infer: true,
        }),
        owner === 'customer'
          ? '/internal/call-read-references/parcel-draft-write/reference'
          : '/internal/parcel-draft-write/reference',
        (owner === 'customer'
          ? event.payload.customerAddress
          : event.payload.consultationAddress) ?? null,
      ),
      this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      {
        eventId: randomUUID(),
        source: 'order',
        eventType: 'ParcelDraftWriteReferenceRequested',
        payload: { operation, input },
      },
      event.eventId,
    ).catch((error: unknown) => this.failure(error));
  }

  customer(id: number) {
    return this.reference<CustomerReference | null>('customer', 'CustomerRead', { id });
  }

  customerByPhone(phone: string) {
    return this.reference<CustomerReference | null>('customer', 'CustomerPhoneRead', { phone });
  }

  canUsePin(customerSeq: number, pinSeq: number) {
    return this.reference<boolean>('customer', 'PinChecked', { customerSeq, pinSeq });
  }

  paymentPolicy(id: number) {
    return this.reference<PaymentPolicy>('customer', 'CustomerPaymentPolicyRead', { id });
  }
  intakeCall(id: number) {
    return this.reference<IntakeCall | null>('consultation', 'IntakeCallRead', { id });
  }
  sealIntake(id: number, payload: IntakeCompletion) {
    return this.reference<IntakeCall | null>('consultation', 'IntakeCallSealed', { id, payload });
  }
  orderCustomer(id: number) {
    return this.reference<CustomerReference | null>('customer', 'OrderCustomerRead', { id });
  }
  async linkOrder(id: number, orderSeq: number, customerSeq: number) {
    const before = this.active.call;
    if (!before || before.callSessionSeq !== id || before.orderSeq !== null)
      throw new Error('Order call is not held');
    const linked = await this.reference<DraftWriteCall | null>('consultation', 'CallOrderLinked', {
      id,
      orderSeq,
      customerSeq,
    });
    if (!linked || linked.orderSeq !== orderSeq || linked.customerSeq === null)
      throw new Error('Order call link was not applied');
    this.active.link = {
      callSessionSeq: id,
      beforeOrderSeq: null,
      beforeCustomerSeq: before.customerSeq,
      orderSeq,
      customerSeq: linked.customerSeq,
    };
    this.active.call = linked;
  }
  async call(id: number) {
    const call = await this.reference<DraftWriteCall | null>('consultation', 'CallRead', { id });
    this.active.call = call;
    return call;
  }

  async resolveCallCustomer(id: number, customerSeq: number) {
    const call = await this.reference<DraftWriteCall | null>(
      'consultation',
      'CallCustomerResolved',
      { id, customerSeq },
    );
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
    this.active.call = call;
  }

  async bumpCall(id: number) {
    const version = await this.reference<number>('consultation', 'CallBumped', { id });
    const call = this.active.call;
    if (!call || call.callSessionSeq !== id || version !== call.intakeVersion + 1)
      throw new Error('Draft call version changed inside its write scope');
    call.intakeVersion = version;
    return version;
  }

  readCalls(input: { callIds: number[]; customerIds: number[]; phones: string[] }) {
    const event = this.active.event;
    return requestDraftCallReferences(
      readCallbackUrl(
        this.config.get('CONSULTATION_URL', { infer: true }),
        '/internal/order-draft-call-references',
        event.payload.consultationAddress ?? null,
      ),
      this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      input,
      event.eventId,
    ).catch((error: unknown) => this.failure(error));
  }

  failure(error: unknown): never {
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
