require('reflect-metadata');
const runtime='./customer-runtime';
const {DatabaseService}=require(runtime+'/database/database.service');
const {AuditService}=require(runtime+'/audit/audit.service');
const {CallScopeService}=require(runtime+'/call-scope/call-scope.service');
const {PinsRepository}=require(runtime+'/pins/pins.repository');
const {PinsService}=require(runtime+'/pins/pins.service');
const event=JSON.parse(process.env.PIN_CRASH_EVENT);
const values={DB_HOST:'customer-db',DB_PORT:5432,DB_USER:'customer_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:'dva_webhook_test',
 OPERATIONS_URL:'http://operations-app:3005',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN};
const config={get:key=>values[key]},database=new DatabaseService(config),audit=new AuditService(database,config),scope=new CallScopeService(database,config,audit);
const original=audit.recordSuccess.bind(audit);
audit.recordSuccess=async(...args)=>{await original(...args);process.stdout.write('prepared\n');await new Promise(()=>{});};
const command=event.payload.command;
scope.run(event,()=>new PinsService(database,new PinsRepository(),audit,scope).updatePersonal(command.id,command.input,null,command.requestId,String(command.callSessionSeq)))
 .catch(()=>{process.stderr.write('scope claimant failed\n');process.exit(1);});
