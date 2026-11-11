import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';

async function responseText(response: Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
@Injectable()
export class PaymentClient {
  timeout = 10000;
  constructor(private readonly config: ConfigService<Environment, true>) {}
  async notify(text: string): Promise<'SENT' | 'FAILED' | 'UNKNOWN'> {
    try {
      const response = await fetch(
        this.config.get('PAYMENT_MATTERMOST_WEBHOOK_URL', { infer: true }),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeout),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
      const body = await responseText(response);
      if (response.status === 200 && body.trim() === 'ok') return 'SENT';
      return response.status >= 400 && response.status < 500 ? 'FAILED' : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }
}
