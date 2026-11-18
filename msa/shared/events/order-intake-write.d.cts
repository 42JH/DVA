import type { DraftWriteCall } from "./parcel-draft-write.cjs";
export interface IntakeCompletion {
  expectedIntakeVersion: number;
  paymentMethodType?: "billing" | "credit" | "groupBilling";
  pickupRequestedAt?: string | null;
}
export interface IntakeCall extends DraftWriteCall {
  completionPayload: IntakeCompletion | null;
  finalizedAt: string | null;
}
export interface PaymentPolicy {
  monthly: boolean;
  group: boolean;
  organizationSeq: number | null;
  departmentSeq: number | null;
  organizationName: string | null;
  departmentName: string | null;
}
export type BillingSnapshot = Pick<PaymentPolicy, 'organizationSeq' | 'departmentSeq' | 'organizationName' | 'departmentName'>;
export interface IntakeFinalization {
  eventId: string;
  callSessionSeq: number;
  expectedIntakeVersion: number;
  finalizedAt: string;
  orderSeq: number | null;
  parcelMappings: { draftSeq: number; orderParcelSeq: number }[];
  requestId: string;
}
export function finalizationId(id: number): string;
export function validateCompletion(
  value: unknown,
): asserts value is IntakeCompletion;
export function validateFinalization(
  value: unknown,
): asserts value is IntakeFinalization;
export function validatePolicy(value: unknown): asserts value is PaymentPolicy;
