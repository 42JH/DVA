import type { Event } from './index.cjs';
export interface CallScopeCommand {
  operation: 'CustomerUpdated' | 'PersonalPinsListed' | 'PersonalPinCreated' | 'PersonalPinUpdated';
  id: number;
  callSessionSeq: number;
  input: Record<string, unknown>;
  requestId: string;
}
export interface CallerScope { phone: string | null; customerSeq: number | null; endedAt: string | null; }
export interface ScopeEvent extends Event { payload: { command: CallScopeCommand; caller?: CallerScope | null; }; }
export function validateScopeEvent(event: unknown, source: 'customer' | 'consultation'): asserts event is ScopeEvent;
export function commandHash(command: CallScopeCommand): string;
export function requestScope(url: string, token: string, event: ScopeEvent): Promise<unknown>;
export class ScopeResponseError extends Error { status: number; error: { code: string; message: string; details: { field: string; reason: string }[] }; }
