import { PaymentError } from './errors.mjs';

async function boundedResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 65536) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class TossTestClient {
  constructor(config, { timeout = 10000 } = {}) {
    this.config = config;
    this.timeout = timeout;
  }
  async request(method, path, body, receiptKey) {
    try {
      const response = await fetch(this.config.tossUrl + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
        headers: {
          Authorization: `Basic ${Buffer.from(this.config.secretKey + ':').toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': receiptKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = JSON.parse(await boundedResponse(response));
      return { status: response.status, data };
    } catch {
      // Never propagate raw URLs, response bodies, errors, card data, or secrets.
      throw new PaymentError(502, 'PAYMENT_RESULT_UNKNOWN');
    }
  }
  confirm(record) {
    return this.request(
      'POST',
      '/v1/payments/confirm',
      {
        paymentKey: record.paymentKey,
        orderId: record.orderId,
        amount: record.amount,
      },
      record.receiptKey,
    );
  }
  lookup(record) {
    return this.request('GET', '/v1/payments/' + encodeURIComponent(record.paymentKey));
  }
}

export class MattermostSender {
  constructor(config, { timeout = 10000 } = {}) {
    this.config = config;
    this.timeout = timeout;
  }
  async send(text) {
    try {
      const response = await fetch(this.config.webhook, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await boundedResponse(response);
      if (response.status === 200 && body.trim() === 'ok') return 'SENT';
      return response.status >= 400 && response.status < 500 ? 'FAILED' : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }
}
