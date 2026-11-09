import type { Event } from './index.cjs';
export interface BillingMonth { organizationSeq: number; billingMonth: string }
export interface BillingOrganization { organizationSeq: number; name: string }
export interface BillingView { organizationSeq: number; organizationName: string | null; month: string; monthlyAmount: number; groupBillingAmount: number }
export interface BillingReadEvent extends Event {
  eventType: 'BillingReadRequested';
  payload: { id: number; month: string | null; organizationName: string | null };
}
export interface BillingOrganizationsEvent extends Event {
  eventType: 'BillingOrganizationsReadRequested';
  payload: Record<string, never>;
}
export interface BillingRolloverEvent extends Event {
  eventType: 'BillingRolloverRequested';
  payload: { months: BillingMonth[]; organizations?: BillingOrganization[] };
}
export type BillingEvent = BillingReadEvent | BillingOrganizationsEvent | BillingRolloverEvent;
export function validateBilling(event: unknown, type: 'BillingReadRequested', source: 'customer'): asserts event is BillingReadEvent;
export function validateBilling(event: unknown, type: 'BillingOrganizationsReadRequested', source: 'order'): asserts event is BillingOrganizationsEvent;
export function validateBilling(event: unknown, type: 'BillingRolloverRequested', source: 'order' | 'customer'): asserts event is BillingRolloverEvent;
export function requestBilling(url: string, token: string, event: BillingReadEvent): Promise<BillingView>;
export function requestBilling(url: string, token: string, event: BillingOrganizationsEvent): Promise<number[]>;
export function requestBilling(url: string, token: string, event: BillingRolloverEvent): Promise<boolean>;
export class BillingError extends Error { status: number; error: { code: string; message: string; details: { field: string; reason: string }[] } }
