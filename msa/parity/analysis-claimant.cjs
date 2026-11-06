require('reflect-metadata');
const {DatabaseService}=require('../dist/database/database.service');
const {AuditService}=require('../dist/audit/audit.service');
const {CallInsightsRepository}=require('../dist/call-insights/call-insights.repository');
const {CallInsightsService}=require('../dist/call-insights/call-insights.service');
const payload=JSON.parse(process.env.ANALYSIS_CRASH_PAYLOAD);
const values={DB_HOST:'consultation-db',DB_PORT:5432,DB_USER:'consultation_app',DB_PASSWORD:process.env.PGPASSWORD,
  DB_NAME:'dva_webhook_test',OPERATIONS_URL:'http://operations-app:3005',CONSULTATION_AUTH_TOKEN:process.env.CONSULTATION_AUTH_TOKEN};
const config={get:key=>values[key]},database=new DatabaseService(config),audit=new AuditService(database,config),repository=new CallInsightsRepository(config,audit);
const pause=async()=>{process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));};
if(payload.mode==='read'){
  const exists=repository.personaVersionExists.bind(repository);
  repository.personaVersionExists=async(...args)=>{const value=await exists(...args);await pause();return value;};
}else if(payload.mode==='prepared'){
  const record=audit.recordSuccess.bind(audit);
  audit.recordSuccess=async(...args)=>{await record(...args);await pause();};
}else if(payload.mode==='committed'){
  const before=audit.beforeCommit.bind(audit);
  audit.beforeCommit=async client=>{const confirm=await before(client);return async()=>{await pause();await confirm?.();};};
}else throw Error('Unknown crash boundary');
new CallInsightsService(database,repository,audit).save(payload.id,payload.input,payload.requestId)
  .then(()=>process.send({status:204}),error=>process.send({status:error.getStatus?.()??500}))
  .finally(async()=>{await database.onModuleDestroy();process.disconnect();});
