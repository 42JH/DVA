import type { Event } from './index.cjs';

export interface DraftWriteCommand {
  operation: 'ParcelDraftCreated' | 'ParcelDraftUpdated';
  id: number | null;
  adminId: number | null;
  callSessionSeq: number | null;
  input: Record<string, unknown>;
  requestId: string;
}
export interface DraftWriteCall {
  callSessionSeq: number;
  callerPhoneNumber: string | null;
  customerSeq: number | null;
  endedAt: string | null;
  orderSeq: number | null;
  enabled: boolean;
  intakeVersion: number;
  completionReceivedAt: string | null;
}
export interface CallMutation {
  callSessionSeq: number;
  beforeVersion: number;
  afterVersion: number;
  customerSeq: number | null;
}
export interface CallWriteReceipt { eventId: string; payload: CallMutation }
export interface DraftWriteResult {
  data: Record<string, unknown>;
  receipt: CallWriteReceipt | null;
}
export interface DraftWriteEvent extends Event {
  source: 'order' | 'consultation' | 'customer';
  eventType: 'ParcelDraftWriteRequested';
  payload: {
    command: DraftWriteCommand;
    orderAddress: string | null;
    consultationAddress?: string | null;
    customerAddress?: string | null;
    call?: Pick<DraftWriteCall, 'callSessionSeq' | 'customerSeq' | 'intakeVersion'> | null;
  };
}
export interface CustomerReference { customerSeq: number; phone: string; active: boolean }
export interface WriteReferenceEvent extends Event {
  source: 'order' | 'customer' | 'consultation';
  eventType: 'ParcelDraftWriteReferenceRequested';
  payload: {
    operation: 'CustomerRead' | 'CustomerPhoneRead' | 'PinChecked' | 'CallRead' |
      'CallBumped' | 'CallCustomerResolved' | 'PendingCallWritesRead';
    input: Record<string, unknown>;
  };
}
export function validateDraftWrite(event: unknown, source: DraftWriteEvent['source']): asserts event is DraftWriteEvent;
export function requestDraftWrite(url: string, token: string, event: DraftWriteEvent): Promise<DraftWriteResult>;
export function validateWriteReference(event: unknown): asserts event is WriteReferenceEvent;
export function requestWriteReference<T>(url: string, token: string, event: WriteReferenceEvent, scopeId?: string): Promise<T>;
export function validateWriteCall(value: unknown): asserts value is DraftWriteCall | null;
export function validateCallMutation(value: unknown): asserts value is CallMutation;
export function validateReceipt(value: unknown): asserts value is CallWriteReceipt;
