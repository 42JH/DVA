import { DRAFT_STATUSES } from '@dva/events/parcel-drafts.cjs';
export const PARCEL_DRAFT_STATUSES = DRAFT_STATUSES;
export type ParcelDraftStatus = (typeof PARCEL_DRAFT_STATUSES)[number];
export interface ParcelDraftRow {
  draftSeq: number;
  reservedOrderSeq: number;
  callSessionSeq: number | null;
  customerSeq: number | null;
  callerPhoneNumber: string | null;
  createdByAdminUserSeq: number | null;
  clientParcelId: string;
  parcel: Record<string, unknown>;
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
