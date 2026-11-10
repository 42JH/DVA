import type {Event} from './index.cjs';
export interface OrderLookup {orderSeq:number;callOrderSeq:number|null;customerSeq:number|null}
export interface ScopeRequest extends Event {
  source:'consultation'; eventType:'CallEventOrderScopeRequested';
  payload:{callbackAddress:string|null;lookup:OrderLookup};
}
export interface ScopeResult extends Event {
  source:'order';eventType:'CallEventOrderChecked';
  payload:{scopeId:string;step:number;lookup:OrderLookup;exists:boolean;allowed:boolean|null};
}
export interface ScopeDirective {next:OrderLookup|null}
export function privateAddress(value:unknown):value is string;
export function validateScopeRequest(value:unknown):asserts value is ScopeRequest;
export function validateScopeResult(value:unknown):asserts value is ScopeResult;
export function validateDirective(value:unknown):asserts value is ScopeDirective;
export function requestPacket(url:string,token:string,event:Event,signal:AbortSignal,maximumBytes?:number|null,readScopeId?:string):Promise<unknown>;
