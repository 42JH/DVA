import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Environment } from '../config/environment';

@Injectable()
export class FaqCallSourcesClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async resolve(eventIds: string[]): Promise<Map<string, number | null>> {
    if (!eventIds.length) return new Map();
    const eventId = randomUUID();
    const response = await fetch(
      (this.config.get('CONSULTATION_URL', { infer: true }) ?? 'http://consultation:3004') +
        '/internal/faq-call-sources',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true })}`,
        },
        body: JSON.stringify({
          eventId,
          source: 'operations',
          eventType: 'FaqCallSourcesRequested',
          payload: { eventIds },
        }),
      },
    );
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    ) {
      await response.body?.cancel();
      throw new Error('FAQ call sources unavailable');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 4096) throw new Error('Invalid FAQ call sources');
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const object = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    if (
      !object(value) ||
      Object.keys(value).sort().join(',') !== 'eventId,payload,status' ||
      value.eventId !== eventId ||
      value.status !== 'processed' ||
      !object(value.payload) ||
      Object.keys(value.payload).join(',') !== 'calls' ||
      !Array.isArray(value.payload.calls) ||
      value.payload.calls.length !== eventIds.length
    )
      throw new Error('Invalid FAQ call sources');
    const calls = new Map<string, number | null>();
    for (const row of value.payload.calls) {
      if (
        !object(row) ||
        Object.keys(row).sort().join(',') !== 'callSessionSeq,eventId' ||
        typeof row.eventId !== 'string' ||
        !eventIds.includes(row.eventId) ||
        calls.has(row.eventId) ||
        (row.callSessionSeq !== null &&
          (!Number.isInteger(row.callSessionSeq) ||
            Number(row.callSessionSeq) < 1 ||
            Number(row.callSessionSeq) > 2147483647))
      )
        throw new Error('Invalid FAQ call sources');
      calls.set(row.eventId, row.callSessionSeq as number | null);
    }
    return calls;
  }
}
