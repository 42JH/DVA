require('reflect-metadata');
const {DatabaseService}=require('../dist/database/database.service');
const {AuditService}=require('../dist/audit/audit.service');
const {BillingService}=require('../dist/billing/billing.service');
const input=JSON.parse(process.env.BILLING_CRASH);
const config={get:key=>({DB_HOST:'order-db',DB_PORT:5432,DB_USER:'order_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:'dva_webhook_test',
  OPERATIONS_URL:'http://operations-app:3005',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN})[key]};
const database=new DatabaseService(config),audit=new AuditService(database,config);
const stop=async phase=>{process.send({phase});await new Promise(resolve=>process.once('message',resolve));};
const record=audit.recordSuccess.bind(audit);let first=true;
audit.recordSuccess=async(...args)=>{await record(...args);if(first){first=false;await stop('prepared');}};
if(input.mode==='committed'){
  const before=audit.beforeCommit.bind(audit);
  audit.beforeCommit=async client=>{const confirm=await before(client);return async()=>{await stop('committed');await confirm?.();};};
}
new BillingService(database,audit,config).initialize(input.event).then(()=>process.exit(0),()=>process.exit(1));
