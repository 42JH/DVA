require('reflect-metadata');
const {DatabaseService}=require('../dist/database/database.service');
const {AuditService}=require('../dist/audit/audit.service');
const {OrdersService}=require('../dist/orders/orders.service');
const {OrdersRepository}=require('../dist/orders/orders.repository');
const {OrderDeletionCheckClient}=require('../dist/orders/order-deletion-check.client');
const payload=JSON.parse(process.env.ORDER_DELETE_CRASH);
const values={DB_HOST:'order-db',DB_PORT:5432,DB_USER:'order_app',DB_PASSWORD:process.env.PGPASSWORD,DB_NAME:'dva_webhook_test',
  OPERATIONS_URL:'http://operations-app:3005',CONSULTATION_URL:'http://consultation-app:3004',CUSTOMER_AUTH_TOKEN:process.env.CUSTOMER_AUTH_TOKEN};
const config={get:key=>values[key]},database=new DatabaseService(config),audit=new AuditService(database,config);
const stop=async phase=>{process.send({phase});await new Promise(resolve=>process.once('message',resolve));};
const record=audit.recordSuccess.bind(audit);
audit.recordSuccess=async(...args)=>{await record(...args);await stop('prepared');};
if(payload.mode==='committed') {
  const before=audit.beforeCommit.bind(audit);
  audit.beforeCommit=async client=>{const confirm=await before(client);return async()=>{await stop('committed');await confirm?.();};};
}else if(payload.mode!=='prepared')throw Error('Unknown crash boundary');
new OrdersService(database,new OrdersRepository(),config,audit,new OrderDeletionCheckClient(config))
  .delete(payload.id,1,payload.requestId)
  .then(()=>process.send({done:true}),()=>process.send({failed:true}))
  .finally(async()=>{await database.onModuleDestroy();process.disconnect();});
