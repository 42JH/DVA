import type { Event } from "./index.cjs";
import type { CallerScope } from "./call-scope.cjs";

export interface CardCallScopeEvent extends Event {
  payload: {
    customerAddress?: string | null;
    registration?: true;
    consultationAddress?: string | null;
  };
}
export interface CardCallerEvent extends Event {
  payload: { scopeId: string; callSessionSeq: number };
}
export function validateCardCallScope(
  event: unknown,
  source: "customer" | "consultation",
): asserts event is CardCallScopeEvent;
export function validateCardCaller(
  event: unknown,
): asserts event is CardCallerEvent;
export function requestCardCaller(
  url: string,
  token: string,
  event: CardCallerEvent,
): Promise<CallerScope>;
