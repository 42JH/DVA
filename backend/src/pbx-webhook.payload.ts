import { BadRequestException } from '@nestjs/common';

export interface CallEndedPayload {
  recordingId: string;
  callFrom: string;
  callTo: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  recordingUrl: string;
}

function text(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException(`Invalid ${field}`);
  }
  return value;
}

function timestamp(body: Record<string, unknown>, field: string): string {
  const value = text(body, field, 35);
  // Require an explicit timezone. Reject JS Date's rollover of invalid calendar dates.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new BadRequestException(`Invalid ${field}: use ISO 8601 with timezone`);
  }
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  const parsed = new Date(value);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)
    || !Number.isFinite(parsed.getTime()) || Number(value.slice(11, 13)) > 23
    || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    throw new BadRequestException(`Invalid ${field}`);
  }
  return parsed.toISOString();
}

export function parseCallEndedPayload(input: unknown): CallEndedPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Expected a JSON object');
  }
  const body = input as Record<string, unknown>;
  const recordingId = text(body, 'recordingId', 200);
  const callFrom = text(body, 'callFrom', 21);
  const callTo = text(body, 'callTo', 21);
  for (const [name, value] of [['callFrom', callFrom], ['callTo', callTo]]) {
    if (!/^\+?[0-9]{3,20}$/.test(value)) throw new BadRequestException(`Invalid ${name}`);
  }
  const startedAt = timestamp(body, 'startedAt');
  const endedAt = timestamp(body, 'endedAt');
  if (endedAt < startedAt) throw new BadRequestException('endedAt must not precede startedAt');
  const durationSeconds = body.durationSeconds;
  if (typeof durationSeconds !== 'number' || !Number.isInteger(durationSeconds)
    || durationSeconds < 0 || durationSeconds > 2147483647) {
    throw new BadRequestException('Invalid durationSeconds');
  }
  const recordingUrl = text(body, 'recordingUrl', 8192);
  let url: URL;
  try { url = new URL(recordingUrl); } catch { throw new BadRequestException('Invalid recordingUrl'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new BadRequestException('recordingUrl must be HTTPS without user credentials or a fragment');
  }
  // No outbound fetch: provider download authentication/expiry and AI processing are not agreed yet.
  // Extra provider fields are ignored; comparison uses these seven normalized contract fields.
  return { recordingId, callFrom, callTo, startedAt, endedAt, durationSeconds, recordingUrl };
}
