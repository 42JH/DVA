import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Environment } from '../config/environment';
import type { CallerContextDto } from './caller-context.types';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const nullable = (
  value: unknown,
  check: (value: Record<string, unknown>) => boolean,
) => value === null || (object(value) && check(value));
const oneOf = (value: unknown, values: string[]) =>
  typeof value === 'string' && values.includes(value);

export function contextResponse(value: unknown): CallerContextDto {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'availablePaymentMethods,availableUsageTypes,companyPins,customer,department,lookupStatus,membership,organization,personalPins' ||
    !oneOf(value.lookupStatus, ['REGISTERED', 'UNREGISTERED', 'WITHDRAWN']) ||
    !nullable(
      value.customer,
      (c) =>
        id(c.customerSeq) &&
        typeof c.name === 'string' &&
        typeof c.phoneNumber === 'string' &&
        c.status === 'ACTIVE' &&
        typeof c.monthlyBillingEnabled === 'boolean' &&
        (c.address === null || object(c.address)),
    ) ||
    !nullable(
      value.membership,
      (m) =>
        id(m.membershipSeq) &&
        id(m.customerSeq) &&
        id(m.organizationSeq) &&
        (m.departmentSeq === null || id(m.departmentSeq)) &&
        typeof m.employeeNo === 'string' &&
        typeof m.monthlyBillingEnabled === 'boolean' &&
        typeof m.groupBillingEnabled === 'boolean' &&
        oneOf(m.role, ['MEMBER', 'ORG_ADMIN']) &&
        oneOf(m.status, ['ACTIVE', 'INACTIVE']),
    ) ||
    !nullable(
      value.organization,
      (o) =>
        id(o.organizationSeq) &&
        typeof o.name === 'string' &&
        oneOf(o.status, ['ACTIVE', 'INACTIVE']) &&
        typeof o.monthlyBillingEnabled === 'boolean' &&
        typeof o.groupCardRegistered === 'boolean',
    ) ||
    !nullable(
      value.department,
      (d) =>
        id(d.departmentSeq) &&
        id(d.organizationSeq) &&
        typeof d.name === 'string' &&
        typeof d.groupBillingEnabled === 'boolean',
    ) ||
    !Array.isArray(value.availablePaymentMethods) ||
    value.availablePaymentMethods.some(
      (v) => !oneOf(v, ['billing', 'credit', 'groupBilling']),
    ) ||
    !Array.isArray(value.availableUsageTypes) ||
    value.availableUsageTypes.some((v) => !oneOf(v, ['PERSONAL', 'COMPANY'])) ||
    !Array.isArray(value.personalPins) ||
    value.personalPins.some(
      (p) =>
        !object(p) ||
        !id(p.personalPinSeq) ||
        !(p.label === null || typeof p.label === 'string') ||
        !object(p.addressData) ||
        !id(p.version),
    ) ||
    !Array.isArray(value.companyPins) ||
    value.companyPins.length !== 0 ||
    (value.lookupStatus === 'REGISTERED') !== (value.customer !== null)
  )
    throw new Error('Invalid customer context response');
  return value as unknown as CallerContextDto;
}

@Injectable()
export class CustomerContextClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  private async query(
    eventType: string,
    phoneNumber: string,
  ): Promise<unknown> {
    const eventId = randomUUID();
    const response = await fetch(
      this.config.get('CUSTOMER_URL', { infer: true }) +
        '/internal/caller-context',
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
          source: 'consultation',
          eventType,
          payload: { phoneNumber },
        }),
      },
    );
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel();
      throw new Error('Customer context unavailable');
    }
    // The public contract returns all personal PINs, so do not silently truncate its snapshot.
    const value: unknown = await response.json();
    if (
      !object(value) ||
      Object.keys(value).sort().join(',') !== 'eventId,payload,status' ||
      value.eventId !== eventId ||
      value.status !== 'processed'
    )
      throw new Error('Invalid customer query acknowledgement');
    return value.payload;
  }

  async context(phoneNumber: string): Promise<CallerContextDto> {
    return contextResponse(
      await this.query('CallerContextRequested', phoneNumber),
    );
  }
  async callCustomer(phoneNumber: string): Promise<number | null> {
    const value = await this.query('CallCustomerRequested', phoneNumber);
    if (
      !object(value) ||
      Object.keys(value).join(',') !== 'customerSeq' ||
      !(value.customerSeq === null || id(value.customerSeq))
    )
      throw new Error('Invalid call customer reference');
    return value.customerSeq as number | null;
  }
}
