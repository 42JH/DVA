export const MIN_ORDER_ITEM_PRICE = 1;
export const MAX_ORDER_ITEM_PRICE = 100_000_000;

export const ORDER_CREATION_SOURCES = ['AI', 'ADMIN', 'UNKNOWN'] as const;
export type OrderCreationSource = (typeof ORDER_CREATION_SOURCES)[number];

export const ORDER_STATUSES = [
  'COLLECTING',
  'notPaid',
  'PAID',
  'SUBMITTING',
  'SUBMITTING_FAILED',
  'ACCEPTED',
  'SUBMISSION_FAILED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
