export const ORDER_CREATION_SOURCES = ['AI', 'ADMIN', 'UNKNOWN'] as const;
export type OrderCreationSource = (typeof ORDER_CREATION_SOURCES)[number];

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
