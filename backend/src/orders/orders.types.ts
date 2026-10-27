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
