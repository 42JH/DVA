export const ORDER_STATUSES = [
  'COLLECTING',
  'SUBMITTING',
  'ACCEPTED',
  'AUTH_FAILED',
  'REVIEW_REQUIRED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SHIPMENT_STATUSES = [
  'notPaid',
  'paid',
  'received',
  'waiting',
  'sent',
  'canceling',
  'canceled',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
