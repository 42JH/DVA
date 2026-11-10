export function validateReadScope(id:unknown):asserts id is string;
export function readCallbackUrl(origin:string,path:string,address:string|null):string;
export class ReadScopes<Client> {
  constructor(unavailable:()=>Error);
  run<T>(id:string,client:Client,work:()=>Promise<T>):Promise<T>;
  use<T>(id:string,work:(client:Client)=>Promise<T>):Promise<T>;
}
