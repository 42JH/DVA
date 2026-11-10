import type { Event } from './index.cjs';
export const ORDER_STATUSES: readonly ['COLLECTING','notPaid','PAID','SUBMITTING','SUBMITTING_FAILED','ACCEPTED','SUBMISSION_FAILED','CANCELLED'];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export interface OrderReadCommand {
  operation: 'OrdersListed' | 'OrderDetailRead' | 'OrderAddressesListed';
  id: number | null;
  callSessionSeq: number | null;
  query: Record<string, unknown>;
}
export interface OrderReadEvent extends Event {
  payload: {
    command: OrderReadCommand;
    caller?: { phone: string | null; endedAt: string | null; orderSeq: number | null };
    customerSeq?: number;
  };
}
export function validateOrderRead(event: unknown, source: 'order' | 'consultation' | 'customer'): asserts event is OrderReadEvent;
export function requestOrderRead(url: string, token: string, event: OrderReadEvent): Promise<unknown>;
export class OrderReadError extends Error {
  status: number;
  error: { code: string; message: string; details: { field: string; reason: string }[] };
}

export interface AdminOrderReadEvent extends Event {
  source:'order'|'consultation'|'customer';eventType:'AdminOrdersReadRequested';
  payload:{query:Record<string,unknown>;orderAddress:string|null;consultationAddress?:string|null;customerAddress?:string|null};
}
export interface AdminOrderReadResult {
  data:{orderSeq:number;customerSeq:number|null;draftSeq:number|null;organizationName:string|null;createdAt:string;pickupRequestedAt:string|null;status:OrderStatus;parcels:unknown[]}[];
  total_count:number;hasNext:boolean;statusCounts:{all:number;incomplete:number;notPaid:number;paid:number;submissionFailed:number;cancelled:number};
}
export function validateAdminOrderRead(event:unknown,source:AdminOrderReadEvent['source']):asserts event is AdminOrderReadEvent;
export function requestAdminOrderRead(url:string,token:string,event:AdminOrderReadEvent):Promise<AdminOrderReadResult>;
