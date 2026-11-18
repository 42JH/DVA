require('reflect-metadata');
const {DatabaseService}=require('../dist/database/database.service');
const {AuditService}=require('../dist/audit/audit.service');
const {UnansweredQuestionsRepository}=require('../dist/unanswered-questions/unanswered-questions.repository');
const {UnansweredQuestionsService}=require('../dist/unanswered-questions/unanswered-questions.service');
const {CallReadReferencesClient}=require('../dist/consultations/call-read-references.client');
const payload=JSON.parse(process.env.CONTENT_CRASH_PAYLOAD);
const values={DB_HOST:'consultation-db',DB_PORT:5432,DB_USER:'consultation_app',DB_PASSWORD:process.env.PGPASSWORD,
  DB_NAME:'dva_webhook_test',OPERATIONS_URL:'http://operations-app:3005',CONSULTATION_AUTH_TOKEN:process.env.CONSULTATION_AUTH_TOKEN};
const database=new DatabaseService({get:key=>values[key]}),audit=new AuditService(database,{get:key=>values[key]});
const pause=async()=>{process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));};
if(payload.mode==='prepared'){
  const record=audit.recordSuccess.bind(audit);
  audit.recordSuccess=async(...args)=>{await record(...args);await pause();};
}else if(payload.mode==='committed'){
  const before=audit.beforeCommit.bind(audit);
  audit.beforeCommit=async client=>{const confirm=await before(client);return async()=>{await pause();await confirm?.();};};
}else throw Error('Unknown crash boundary');
const service=new UnansweredQuestionsService(database,new UnansweredQuestionsRepository(database,new CallReadReferencesClient({get:key=>values[key]})),audit);
const work=payload.operation==='convert'
  ? service.convert(payload.id,payload.input,payload.adminId,payload.requestId)
  : payload.operation==='delete'
  ? service.delete(payload.id,payload.adminId,payload.requestId)
  : service.collect(payload.input,payload.requestId);
work.then(()=>process.send({done:true}),()=>process.send({failed:true}))
  .finally(async()=>{await database.onModuleDestroy();process.disconnect();});
