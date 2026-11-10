import type {Event} from './index.cjs';
import type {OrderStatus} from './order-read.cjs';
export interface ReferenceQuery extends Event {
  source:'consultation'|'order';eventType:'CallReadReferencesRequested';payload:{ids:number[]};
}
export type ReferenceRows={
  order:{order_seq:number;customer_seq:number|null;status:OrderStatus;total_amount:number|null};
  customer:{customer_seq:number;name:string;organization_seq:number|null;organization_name:string|null};
  persona:{ai_persona_version_seq:number;name:string;version:number};
  faq:{faq_entry_seq:number};
};
export function validateReferenceQuery(value:unknown,source?:'consultation'|'order'):asserts value is ReferenceQuery;
export function validateReferenceRows<K extends keyof ReferenceRows>(kind:K,value:unknown,ids:number[]):asserts value is ReferenceRows[K][];
export function requestReferences<K extends keyof ReferenceRows>(kind:K,url:string,token:string,ids:number[],source?:'consultation'|'order',readScopeId?:string):Promise<ReferenceRows[K][]>;
export interface PersonaComparisonRow {
  ai_persona_seq:number;ai_persona_version_seq:number;name:string;version:number;
  status:'ACTIVE'|'PENDING'|'INACTIVE';previous_active_version_seq:number|null;
}
export function validatePersonaComparisonQuery(value:unknown):asserts value is Event;
export function validatePersonaComparisonRows(value:unknown):asserts value is PersonaComparisonRow[];
export function requestPersonaComparison(url:string,token:string):Promise<PersonaComparisonRow[]>;
export type ComplaintFaqRow={question:string;answer:string};
export function validateComplaintFaqQuery(value:unknown):asserts value is Event;
export function validateComplaintFaqRows(value:unknown):asserts value is ComplaintFaqRow[];
export function requestComplaintFaqs(url:string,token:string):Promise<ComplaintFaqRow[]>;

export interface OrderOrganization {organization_seq:number;organization_name:string|null;customer_seqs:number[]}
export function validateOrderOrganizationQuery(value:unknown):asserts value is Event & {payload:{organizationSeq:number}};
export function validateOrderOrganizationRows(value:unknown,organizationSeq:number):asserts value is OrderOrganization;
export function requestOrderOrganization(url:string,token:string,organizationSeq:number,readScopeId?:string):Promise<OrderOrganization>;
