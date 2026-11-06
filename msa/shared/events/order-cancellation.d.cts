import type { Event } from './index.cjs';
export interface OrderCancellationCommand {
  id: number;
  callSessionSeq: number;
  requestId: string;
  orderParcelSeqs: number[] | null;
}
export interface OrderCancellationEvent extends Event {
  payload: {
    command: OrderCancellationCommand;
    caller?: { phone: string | null; endedAt: string | null; orderSeq: number | null };
    customerSeq?: number;
  };
}
export function validateOrderCancellation(event: unknown, source: 'order' | 'consultation' | 'customer'): asserts event is OrderCancellationEvent;
export function requestOrderCancellation(url: string, token: string, event: OrderCancellationEvent): Promise<null>;
export class OrderCancellationError extends Error {
  status: number;
  error: { code: string; message: string; details: { field: string; reason: string }[] };
}
