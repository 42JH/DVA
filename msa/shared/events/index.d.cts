export interface Event {
  eventId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
}
export function enqueue(client: { query(sql: string, values?: unknown[]): Promise<unknown> }, input: {
  destination: string; eventType: string; aggregateSeq: number; payload: Record<string, unknown>;
}): Promise<string>;
export function createReceiver<Client>(options: {
  pool: { connect(): Promise<Client> };
  sources: Record<string, string>;
  handlers: Record<string, (client: Client, event: Event) => Promise<void>>;
}): (event: Event, authorization: string) => Promise<{eventId: string; status: string}>;
export function createRelay(options: {
  pool: { connect(): Promise<unknown> }; source: string;
  destinations: Record<string, {url: string; token: string}>; timeoutMs?: number; eventTypes?: string[];
}): (auditTransactions?: readonly string[]) => Promise<boolean>;
export function flushAuditSnapshot(
  pool: { query(sql: string, values: unknown[]): PromiseLike<unknown> },
  relay: (auditTransactions: readonly string[]) => Promise<boolean>,
  reconcile: (ids: string[]) => Promise<string[]>, ids: string[],
): Promise<void>;
export function sendEvent(
  url: string, token: string, event: Event, signal?: AbortSignal | null,
  extraHeaders?: { 'X-Dva-Audit-Snapshot': '1' },
): Promise<void>;
export function validateEvent(event: unknown): asserts event is Event;
