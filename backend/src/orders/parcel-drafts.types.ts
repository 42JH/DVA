import { OrderDraft } from './order-draft';

export const PARCEL_DRAFT_STATUSES = [
  'READY',
  'EDITING',
  'INCOMPLETE',
  'CONVERTED',
  'CANCELLED',
  'RESUMED',
] as const;
export type ParcelDraftStatus = (typeof PARCEL_DRAFT_STATUSES)[number];
export const DRAFT_CLEAR_FIELDS = [
  'origin',
  'destination',
  'items',
  'itemPrice',
  'notifiedPrice',
  'originPin',
  'clientComment',
] as const;
export type DraftClearField = (typeof DRAFT_CLEAR_FIELDS)[number];

export interface ParcelDraftRow {
  draftSeq: number;
  callSessionSeq: number | null;
  customerSeq: number | null;
  createdByAdminUserSeq: number | null;
  clientParcelId: string;
  creationPayload: Record<string, unknown>;
  parcel: OrderDraft['parcels'][number];
  status: ParcelDraftStatus;
  version: number;
  sourceDraftSeq: number | null;
  orderParcelSeq: number | null;
  legacyOrderSeq: number | null;
  legacyOrderParcelSeq: number | null;
  createdAt: Date;
  updatedAt: Date;
  retentionStartedAt: Date;
}

export interface OrderIntakeCall {
  callSessionSeq: number;
  callerPhoneNumber: string | null;
  customerSeq: number | null;
  endedAt: Date | null;
  orderSeq: number | null;
  enabled: boolean;
  intakeVersion: number;
  completionReceivedAt: Date | null;
  completionPayload: {
    expectedIntakeVersion: number;
    paymentMethodType?: 'billing' | 'credit' | 'groupBilling';
    pickupRequestedAt?: string | null;
  } | null;
  finalizedAt: Date | null;
  finalizationResult: {
    orderSeq: number | null;
    parcelMappings: { draftSeq: number; orderParcelSeq: number }[];
  } | null;
  errorCode: string | null;
}
