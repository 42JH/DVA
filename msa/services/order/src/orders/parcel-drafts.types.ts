import type { OrderDraft } from './order-draft';
import { DRAFT_STATUSES } from '@dva/events/parcel-drafts.cjs';
export const PARCEL_DRAFT_STATUSES = DRAFT_STATUSES;
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
  reservedOrderSeq: number;
  callSessionSeq: number | null;
  customerSeq: number | null;
  callerPhoneNumber: string | null;
  createdByAdminUserSeq: number | null;
  clientParcelId: string;
  creationPayload?: Record<string, unknown>;
  parcel: OrderDraft['parcels'][number];
  status: ParcelDraftStatus;
  version: number;
  sourceDraftSeq: number | null;
  orderSeq: number | null;
  orderParcelSeq: number | null;
  legacyOrderSeq: number | null;
  legacyOrderParcelSeq: number | null;
  createdAt: Date;
  updatedAt: Date;
  retentionStartedAt: Date;
}
