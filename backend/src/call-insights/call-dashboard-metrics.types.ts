export const DROPOFF_STAGES = [
  'SENDER_INFO',
  'RECIPIENT_INFO',
  'ITEM_INFO',
  'CONFIRMATION',
  'PAYMENT_GUIDANCE',
  'FAQ_ANSWER',
  'ORDER_LOOKUP',
  'ORDER_CANCEL',
  'NONE',
] as const;
export type DropoffStage = (typeof DROPOFF_STAGES)[number];

export const LATENCY_PROCESS_TYPES = [
  'CUSTOMER_LOOKUP',
  'INFORMATION_INPUT',
  'FAQ_LOOKUP',
  'ORDER_LOOKUP',
  'ORDER_CANCEL',
  'ADDRESS_LOOKUP',
  'ORDER_SAVE',
] as const;
export type LatencyProcessType = (typeof LATENCY_PROCESS_TYPES)[number];
