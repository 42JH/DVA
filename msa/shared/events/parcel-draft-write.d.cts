import type {CustomerCreationReceipt} from './order-customer-write.cjs';
import type {RecipientReceipt} from './order-recipient-pins.cjs';
import type { Event } from './index.cjs';

export interface DraftWriteCommand {
  operation: 'OrderCreated' | 'ManualOrderCreated' | 'ParcelDraftCreated' | 'ParcelDraftUpdated' | 'OrderIntakeSealed' | 'OrderIntakeFinalized' | 'OrderUpdated' | 'OrderSubmitted' | 'AdminParcelDraftSubmitted';
  key?: string;
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
export interface CallOrderLink {
  callSessionSeq:number;
  beforeOrderSeq:null;
  beforeCustomerSeq:number|null;
  orderSeq:number;
  customerSeq:number;
}
export interface OrderCallIdentity {providerCallId:string;callerPhoneNumber:string;incomingAt:string}
export interface LegacyCallWrite {
  creationKey:string;
  callSessionSeq:number;
  beforeCustomerSeq:number|null;
  customerSeq:number|null;
  orderSeq:number|null;
  call:OrderCallIdentity|null;
  adminId:number|null;
  requestId:string;
}
export interface OwnerCallWriteReceipt {eventId:string;payload:CallMutation|CallOrderLink|LegacyCallWrite}
export interface CallWriteReceipt { eventId: string; payload: CallMutation }
export interface DraftWriteResult {
  data: Record<string, unknown>;
  receipt: OwnerCallWriteReceipt | null;
  customerReceipt?: RecipientReceipt | null;
  customerCreationReceipt?:CustomerCreationReceipt|null;
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
    operation: 'CustomerOrderResolved' | 'CustomerCreationApplied' | 'CallCustomerRead' | 'CallEnsured' | 'LegacyCallApplied' | 'CallCreationChecked' | 'CustomerPreparationOutcomeRead' | 'RecipientPinsPrepared' | 'OrderRecipientsRead' | 'RecipientReceiptRead' | 'OrderCustomerRead' | 'CallOrderLinked' | 'IntakeCallRead' | 'IntakeCallSealed' | 'IntakeFinalizationRead' | 'CustomerPaymentPolicyRead' | 'CustomerPaymentCardRead' | 'CustomerApprovalCardRead' | 'CustomerRead' | 'CustomerPhoneRead' | 'PinChecked' | 'CallRead' |
      'CallBumped' | 'CallCustomerResolved' | 'PendingCallWritesRead' | 'OrderBillingSnapshotRead' | 'OrderPendingCardApprovalRead';
    input: Record<string, unknown>;
  };
}
export function validateDraftWrite(event: unknown, source: DraftWriteEvent['source']): asserts event is DraftWriteEvent;
export function requestDraftWrite(url: string, token: string, event: DraftWriteEvent): Promise<DraftWriteResult>;
export function validateWriteReference(event: unknown): asserts event is WriteReferenceEvent;
export function requestWriteReference<T>(url: string, token: string, event: WriteReferenceEvent, scopeId?: string): Promise<T>;
export function validateWriteCall(value: unknown): asserts value is DraftWriteCall | null;
export function validateCallMutation(value: unknown): asserts value is CallMutation;
export function validateReceipt(value: unknown): asserts value is OwnerCallWriteReceipt;

export function validateOrderCallLink(value:unknown):asserts value is CallOrderLink;
export function validateLegacyCallWrite(value:unknown):asserts value is LegacyCallWrite;

export interface StoredPaymentCard {
  paymentCardSeq: number;
  encryptedBillingKey: string | null;
  providerCustomerKey: string;
  providerEnvironment: 'test' | 'live';
}
export interface CardApprovalScopeEvent extends Event {
  source: 'order' | 'customer';
  eventType: 'OrderCardApprovalRequested';
  payload: {
    paymentRequestId: string;
    orderAddress: string | null;
    customerAddress?: string | null;
  };
}
export function validateCardApprovalScope(event: unknown, source: CardApprovalScopeEvent['source']): asserts event is CardApprovalScopeEvent;
export function requestCardApprovalScope(url: string, token: string, event: CardApprovalScopeEvent): Promise<true>;
