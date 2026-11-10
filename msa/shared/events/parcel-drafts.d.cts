import type { Event } from './index.cjs';
export interface LegacyDraftCallBinding { orderSeq: number; callSessionSeq: number | null; callerPhoneNumber: string | null }
export interface LegacyDraftReadEvent extends Event { eventType: 'LegacyDraftCallBindingsReadRequested'; payload: { orderSeqs: number[] } }
export interface LegacyDraftPruneEvent extends Event { eventType: 'LegacyDraftCallBindingsPruneRequested'; payload: Record<string, never> }
export interface CallDraftDeletionEvent extends Event { eventType: 'CallDraftDeletionCheckRequested'; payload: { callSessionSeq: number } }
export function validateParcelDraftCommand(event: unknown, type: 'LegacyDraftCallBindingsReadRequested', source: 'order'): asserts event is LegacyDraftReadEvent;
export function validateParcelDraftCommand(event: unknown, type: 'LegacyDraftCallBindingsPruneRequested', source: 'order'): asserts event is LegacyDraftPruneEvent;
export function validateParcelDraftCommand(event: unknown, type: 'CallDraftDeletionCheckRequested', source: 'consultation'): asserts event is CallDraftDeletionEvent;
export function requestParcelDraftCommand(url: string, token: string, event: LegacyDraftReadEvent): Promise<LegacyDraftCallBinding[]>;
export function requestParcelDraftCommand(url: string, token: string, event: LegacyDraftPruneEvent | CallDraftDeletionEvent): Promise<boolean>;
export function restoreLegacyDraftBindings(database: { pool: { query(sql: string): Promise<{ rows: { completed: boolean }[] }> }; transaction<T>(work: (client: { query(sql: string, values?: unknown[]): Promise<{ rows: { legacy_order_seq: number }[]; rowCount: number | null }> }) => Promise<T>): Promise<T> }, consultationUrl: string, token: string): Promise<void>;

export interface DraftCallQuery { callIds: number[]; customerIds: number[]; phones: string[]; phoneHashes: string[] }
export interface DraftCallEvent extends Event { source: 'order'; eventType: 'DraftCallReferencesRequested'; payload: DraftCallQuery }
export interface DraftCallReferences {
  calls: { call_session_seq: number; started_at: string | null }[];
  customers: { customer_seq: number; call_session_seq: number; started_at: string }[];
  phones: { caller_phone_number: string; call_session_seq: number; started_at: string }[];
}
export function validateParcelDraftCommand(event: unknown, type: 'DraftCallReferencesRequested', source: 'order'): asserts event is DraftCallEvent;
export function requestParcelDraftCommand(url: string, token: string, event: DraftCallEvent, readScopeId?:string): Promise<DraftCallReferences>;
export function validateDraftCallReferences(rows: unknown, query: DraftCallQuery): asserts rows is DraftCallReferences;
export function requestDraftCallReferences(url: string, token: string, input: {callIds: number[]; customerIds: number[]; phones: string[]}, readScopeId?:string): Promise<DraftCallReferences>;

export const DRAFT_STATUSES:readonly ['READY','EDITING','INCOMPLETE','CONVERTED','CANCELLED','RESUMED'];
export interface DraftReadCommand {operation:'ParcelDraftsListed'|'ParcelDraftDetailRead';id:number|null;callSessionSeq:number|null;query:Record<string,unknown>}
export interface DraftReadEvent extends Event {source:'order'|'consultation'|'customer';eventType:'ParcelDraftReadRequested';payload:{command:DraftReadCommand;orderAddress:string|null;consultationAddress?:string|null;customerAddress?:string|null;customerSeq?:number|null}}
export interface DraftReadCall {callSessionSeq:number;callerPhoneNumber:string|null;customerSeq:number|null;endedAt:string|null;enabled:boolean;intakeVersion:number}
export function validateDraftRead(event:unknown,source:DraftReadEvent['source']):asserts event is DraftReadEvent;
export function validateDraftReadCallQuery(event:unknown):asserts event is Event&{payload:{callSessionSeq:number}};
export function validateDraftReadCall(value:unknown,callSessionSeq:number):asserts value is DraftReadCall;
export function requestDraftReadCall(url:string,token:string,callSessionSeq:number,readScopeId:string,source?:'order'|'customer'):Promise<DraftReadCall>;
export function validateDraftReadResult(value:unknown,command:DraftReadCommand):void;
