import { randomBytes, randomUUID } from 'node:crypto';
import { PaymentError } from './errors.mjs';
import { paymentMessage } from './message.mjs';

export class PaymentTestService {
  #confirming = new Map();
  #notifying = new Map();
  constructor(config, store, toss, sender, { now = () => Date.now() } = {}) {
    Object.assign(this, { config, store, toss, sender, now });
  }
  async createSample() {
    const token = randomBytes(32).toString('hex');
    const record = {
      token,
      orderId: 'DVA_TEST_' + randomUUID(),
      orderName: 'DVA 택배 테스트 결제',
      senderName: '테스트 발송인',
      recipientSummary: '테스트 수령인',
      parcelCount: 1,
      pickupRequestedAt: new Date(this.now() + 86400000).toISOString(),
      amount: 1000,
      status: 'PENDING',
      notificationStatus: 'NOT_SENT',
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 86400000).toISOString(),
      receiptKey: randomUUID(),
      paymentKey: null,
      approvedAt: null,
    };
    await this.store.change((records) => {
      if (Object.keys(records).length >= 500) throw new PaymentError(409, 'DEMO_CAPACITY_REACHED');
      records[token] = record;
    });
    return { ...this.publicRecord(record), paymentUrl: this.paymentUrl(token), token };
  }
  paymentUrl(token) {
    return `${this.config.publicUrl}/p/${token}`;
  }
  publicRecord(record) {
    const {
      orderId,
      orderName,
      senderName,
      recipientSummary,
      parcelCount,
      pickupRequestedAt,
      amount,
      status,
      approvedAt,
      expiresAt,
      notificationStatus,
    } = record;
    const expired = ['PENDING', 'FAILED'].includes(status) && Date.parse(expiresAt) <= this.now();
    return {
      orderId,
      orderName,
      senderName,
      recipientSummary,
      parcelCount,
      pickupRequestedAt,
      amount,
      status: expired ? 'EXPIRED' : status,
      approvedAt,
      expiresAt,
      notificationStatus,
    };
  }
  async read(token) {
    return this.publicRecord(await this.store.find(token));
  }
  async reconcile(token) {
    const r = await this.store.find(token);
    if (!r.paymentKey || !['CONFIRMING', 'REVIEW_REQUIRED', 'PAID'].includes(r.status))
      throw new PaymentError(409, 'INVALID_STATE');
    return this.confirm(token, { amount: r.amount, orderId: r.orderId, paymentKey: r.paymentKey });
  }
  notify(token) {
    if (this.#notifying.has(token)) return this.#notifying.get(token);
    const promise = this.#notify(token).finally(() => this.#notifying.delete(token));
    this.#notifying.set(token, promise);
    return promise;
  }
  async #notify(token) {
    const record = await this.store.change((records) => {
      const r = records[token];
      if (!r) throw new PaymentError(404, 'NOT_FOUND');
      if (r.notificationStatus !== 'NOT_SENT')
        throw new PaymentError(409, 'MESSAGE_ALREADY_ATTEMPTED');
      if (r.status !== 'PENDING' || Date.parse(r.expiresAt) <= this.now())
        throw new PaymentError(409, 'INVALID_STATE');
      r.notificationStatus = 'SENDING';
      return r;
    });
    const status = await this.sender.send(paymentMessage(record, this.paymentUrl(token)));
    await this.store.change((records) => {
      records[token].notificationStatus = status;
    });
    return { notificationStatus: status };
  }
  confirm(token, input) {
    if (
      !input ||
      Object.keys(input).sort().join(',') !== 'amount,orderId,paymentKey' ||
      !Number.isSafeInteger(input.amount) ||
      input.amount <= 0 ||
      typeof input.orderId !== 'string' ||
      typeof input.paymentKey !== 'string' ||
      !/^[\x21-\x7e]{1,200}$/.test(input.paymentKey)
    )
      return Promise.reject(new PaymentError(400, 'INVALID_REQUEST'));
    const active = this.#confirming.get(token);
    if (active) {
      if (active.signature !== JSON.stringify([input.orderId, input.amount, input.paymentKey]))
        return Promise.reject(new PaymentError(409, 'CONFIRMATION_IN_PROGRESS'));
      return active.promise;
    }
    const promise = this.#confirm(token, input).finally(() => this.#confirming.delete(token));
    this.#confirming.set(token, {
      promise,
      signature: JSON.stringify([input.orderId, input.amount, input.paymentKey]),
    });
    return promise;
  }
  async #confirm(token, input) {
    let lookupOnly = false;
    const record = await this.store.change((records) => {
      const r = records[token];
      if (!r) throw new PaymentError(404, 'NOT_FOUND');
      if (r.orderId !== input.orderId || r.amount !== input.amount)
        throw new PaymentError(400, 'PAYMENT_DETAILS_MISMATCH');
      if (r.paymentKey && r.paymentKey !== input.paymentKey)
        throw new PaymentError(409, 'PAYMENT_KEY_MISMATCH');
      if (r.status === 'PAID') return r;
      if (r.status === 'FAILED') throw new PaymentError(409, 'PAYMENT_FAILED');
      if (Date.parse(r.expiresAt) <= this.now() && r.status === 'PENDING')
        throw new PaymentError(410, 'PAYMENT_EXPIRED');
      lookupOnly = ['CONFIRMING', 'REVIEW_REQUIRED'].includes(r.status);
      r.status = 'CONFIRMING';
      r.paymentKey = input.paymentKey;
      return r;
    });
    if (record.status === 'PAID') return this.publicRecord(record);
    let result;
    try {
      result = lookupOnly ? await this.toss.lookup(record) : await this.toss.confirm(record);
      if (!lookupOnly && result.data?.code === 'ALREADY_PROCESSED_PAYMENT')
        result = await this.toss.lookup(record);
    } catch {
      await this.store.change((records) => {
        records[token].status = 'REVIEW_REQUIRED';
      });
      throw new PaymentError(502, 'PAYMENT_RESULT_UNKNOWN');
    }
    const data = result.data;
    const match =
      result.status === 200 &&
      data?.status === 'DONE' &&
      data.paymentKey === record.paymentKey &&
      data.orderId === record.orderId &&
      data.totalAmount === record.amount &&
      data.currency === 'KRW' &&
      typeof data.approvedAt === 'string' &&
      Number.isFinite(Date.parse(data.approvedAt));
    if (match) {
      // A failed local commit leaves CONFIRMING durable. A restart/retry performs GET only.
      return this.store.change((records) => {
        records[token].status = 'PAID';
        records[token].approvedAt = new Date(data.approvedAt).toISOString();
        return this.publicRecord(records[token]);
      });
    }
    // Only a definite rejection is terminal; processing/provider errors can hide success.
    const declined =
      !lookupOnly &&
      result.status >= 400 &&
      result.status < 500 &&
      data?.code === 'REJECT_CARD_PAYMENT';
    await this.store.change((records) => {
      records[token].status = declined ? 'FAILED' : 'REVIEW_REQUIRED';
    });
    throw new PaymentError(
      declined ? 422 : 502,
      declined ? 'PAYMENT_FAILED' : 'PAYMENT_RESULT_UNKNOWN',
    );
  }
}
