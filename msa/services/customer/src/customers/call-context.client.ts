import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ApiException, type ErrorCode, type ErrorDetail } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import type { CallerContextDto, CallerContextRequestDto } from './dto/caller-context.dto';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
@Injectable()
export class CallContextClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}
  async context(
    input: CallerContextRequestDto,
    actorId: number | null,
    requestId: string,
  ): Promise<CallerContextDto> {
    const origin = this.config.get('CONSULTATION_URL', { infer: true });
    if (!origin) throw new Error('Call registration unavailable');
    const eventId = randomUUID();
    const response = await fetch(origin + '/internal/caller-context', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      },
      body: JSON.stringify({
        eventId,
        source: 'customer',
        eventType: 'CallerContextRequested',
        payload: { input, actorId, requestId },
      }),
    });
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error('Invalid call registration response');
    }
    const value: unknown = await response.json();
    if (response.status !== 200) {
      if (
        [400, 409, 503].includes(response.status) &&
        object(value) &&
        ['INVALID_REQUEST', 'INVALID_STATE', 'DEPENDENCY_UNAVAILABLE'].includes(
          String(value.code),
        ) &&
        typeof value.message === 'string' &&
        Array.isArray(value.details) &&
        value.details.every(
          (d) => object(d) && typeof d.field === 'string' && typeof d.reason === 'string',
        )
      )
        throw new ApiException(
          response.status,
          value.code as ErrorCode,
          value.message,
          value.details as ErrorDetail[],
        );
      throw new Error('Call registration unavailable');
    }
    if (
      !object(value) ||
      Object.keys(value).sort().join(',') !== 'eventId,payload,status' ||
      value.eventId !== eventId ||
      value.status !== 'processed' ||
      !object(value.payload)
    )
      throw new Error('Invalid call registration acknowledgement');
    const context = value.payload;
    if (
      Object.keys(context).sort().join(',') !==
        'availablePaymentMethods,availableUsageTypes,callSessionSeq,companyPins,customer,department,lookupStatus,membership,organization,personalPins' ||
      !Number.isInteger(context.callSessionSeq) ||
      Number(context.callSessionSeq) < 1 ||
      Number(context.callSessionSeq) > 2147483647 ||
      !['REGISTERED', 'UNREGISTERED', 'WITHDRAWN'].includes(String(context.lookupStatus)) ||
      ![context.customer, context.membership, context.organization, context.department].every(
        (v) => v === null || object(v),
      ) ||
      ![
        context.availablePaymentMethods,
        context.availableUsageTypes,
        context.personalPins,
        context.companyPins,
      ].every(Array.isArray)
    )
      throw new Error('Invalid registered context');
    return context as unknown as CallerContextDto;
  }
}
