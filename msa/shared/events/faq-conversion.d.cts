import type {Event} from './index.cjs';
export const FAQ_CATEGORIES:readonly ['접수','수거 일정','물품·박스','포장·파손','배송·운송장','주소','변경·취소','요금·결제','이용 안내','기타'];
export type FaqCategory=typeof FAQ_CATEGORIES[number];
export interface FaqConversionPayload {
  transactionId:string;requestId:string;adminId:number;
  faq:{category:FaqCategory;question:string;answer:string};
}
export interface FaqConversionEvent extends Event { source:'consultation';eventType:'FaqConversionPrepared';payload:FaqConversionPayload&Record<string,unknown> }
export function validateFaqConversionPayload(value:unknown):asserts value is FaqConversionPayload;
export function validateFaqConversionEvent(value:unknown):asserts value is FaqConversionEvent;
export class FaqWritePending extends Error {}
export class FaqConversionConflict extends Error {code:'23505'}
export function retryFaqWrite<T>(work:()=>Promise<T>):Promise<T>;
export function requestFaqConversion(url:string,token:string,payload:{eventId:string;input:FaqConversionPayload}):Promise<number>;
