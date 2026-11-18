require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID, createHmac } = require('node:crypto');
const { authenticationRecord } = require('../dist/observability/security-events');
const { logRecord } = require('../dist/observability/json-logger');
const { requestContext } = require('../dist/common/http/request-context');
const { validateEnvironment } = require('../dist/config/environment');
const key='ab'.repeat(32);
const serviceName=require('../package.json').name;
const request=(extra={})=>({method:'POST',path:'/api/auth/login',requestId:randomUUID(),body:{loginId:'Operator01',password:'PRIVATE-password'},socket:{remoteAddress:'::ffff:192.0.2.1'},get:()=>undefined,...extra});

test('array delete DTOs accept only one to one hundred unique positive int32 owner IDs',()=>{
  const {plainToInstance}=require('class-transformer'),{validateSync}=require('class-validator');
  const contracts=require('../dist/common/dto/delete-request.dto');
  assert.equal(Object.keys(contracts).length,{operations:1,customer:4,consultation:2,order:2}[serviceName]);
  const fields={DeleteAdminsDto:'adminUserSeqs',DeleteCallsDto:'callSessionSeqs',DeleteOrdersDto:'orderSeqs',
    DeleteDraftsDto:'draftSeqs',DeleteMembersDto:'membershipSeqs',DeleteDepartmentsDto:'departmentSeqs',
    DeleteQuestionsDto:'unansweredQuestionSeqs',DeleteCustomerCardsDto:'customerSeqs',DeleteCompanyCardsDto:'organizationSeqs'};
  const check=(type,input)=>validateSync(plainToInstance(type,input),{whitelist:true,forbidNonWhitelisted:true});
  for(const [name,type]of Object.entries(contracts)){
    const field=fields[name];assert.ok(field,name);
    for(const value of [[1],[2147483647],Array.from({length:100},(_,index)=>index+1)])
      assert.deepEqual(check(type,{[field]:value}),[]);
    for(const value of [undefined,null,[],1,'1',[1,1],[0],[-1],[1.1],['1'],[true],[2147483648],
      Array.from({length:101},(_,index)=>index+1)])assert.ok(check(type,{[field]:value}).length,name+' '+JSON.stringify(value));
    assert.ok(check(type,{[field]:[1],extra:'PRIVATE'}).length);
  }
});

test('array failure audits identify only a single valid owner and preserve actor and legacy target rules',()=>{
  const {auditEvent}=require('../dist/audit/audit-operation');
  const options={action:'DELETED',targetType:'ORDER',target:'ids',idsField:'ownerSeqs'};
  const input={params:{id:'9'},body:{ownerSeqs:[7]},admin:{adminUserSeq:3,name:'운영자'},requestId:randomUUID()};
  for(const [ids,target]of [[[7],7],[[2147483647],2147483647],[[1,2],null],[[1,1],null],[[],null],
    [['7'],null],[[0],null],[[-1],null],[[1.1],null],[[2147483648],null],[null,null],[7,null]]){
    const event=auditEvent(options,{...input,body:{ownerSeqs:ids}});
    assert.equal(event.targetId,target);assert.equal(event.actorId,3);assert.equal(event.actorName,'운영자');
    assert.equal(event.actorType,'ADMIN');assert.equal(event.requestId,input.requestId);
  }
  const ai=auditEvent(options,{...input,auditActorType:'AI'});
  assert.equal(ai.actorType,'AI');assert.equal(ai.actorId,null);assert.equal(ai.actorName,undefined);
  assert.equal(auditEvent({...options,target:'actor'},input).targetId,3);
  assert.equal(auditEvent({...options,target:'id'},input).targetId,9);
  assert.equal(auditEvent({...options,target:'none'},input).targetId,null);
});

test('operational events retain source outcomes without transcripts, credentials or model responses',()=>{
  const events=['call_complaint_claim_deferred','call_complaint_failed','call_complaint_recording_unavailable',
    'call_complaint_input_too_long','call_complaint_model_unavailable','call_complaint_judged',
    'active_call_count_unavailable','card_payment_deferred','order_intake_finalization_deferred',
    'order_intake_submission_deferred','order_intake_recovery_failed','card_revocation_deferred','call_end_matching_deferred'];
  for(const event of events){
    const safe=logRecord('warn',{event,callSessionSeq:12,durationMs:1.8,hasComplaint:false,complaintCount:0,
      transcript:'PRIVATE',votes:'PRIVATE',tokens:'PRIVATE',password:'PRIVATE',body:'PRIVATE',error:new Error('PRIVATE')});
    assert.equal(safe.service,serviceName);assert.equal(safe.event,event);assert.equal(safe.callSessionSeq,12);assert.equal(safe.durationMs,2);
    assert.ok(!JSON.stringify(safe).includes('PRIVATE'));
    assert.equal(safe.hasComplaint,event==='call_complaint_judged'?false:undefined);
    assert.equal(safe.complaintCount,event==='call_complaint_judged'?0:undefined);
  }
  for(const count of [-1,0.5,'1',2147483648])assert.equal(logRecord('info',{
    event:'call_complaint_judged',hasComplaint:'false',complaintCount:count,
  }).complaintCount,undefined);
});

test('domain and HTTP boundaries record one failure per exception object and request',async()=>{
  const {AuditService}=require('../dist/audit/audit.service');
  const {HttpException}=require('@nestjs/common'),writes=[];
  const insert=async(event,result)=>{writes.push({event,result});};
  const database={pool:{},transaction:async work=>work({})};
  const service=logRecord('info',{}).service==='operations'
    ?new AuditService({insert},{})
    :new AuditService(database,{get:key=>key.endsWith('_URL')?'http://operations:3005':'audit-test-token-'.padEnd(48,'x')});
  service.recordResult=insert;
  const event={actorId:null,actorType:'SYSTEM',action:'FAILURE',targetType:'ORDER',targetId:1,requestId:randomUUID()};
  const error=new Error('PRIVATE');
  await Promise.all([service.recordFailure(event,error),service.recordFailure(event,error)]);
  assert.equal(writes.length,1);assert.equal(writes[0].result,'FAILED');
  await service.recordFailure({...event,requestId:randomUUID()},error);assert.equal(writes.length,2);
  await service.recordFailure(event,undefined);await service.recordFailure(event,undefined);
  assert.equal(writes.length,4);
  await service.recordFailure(event,new HttpException('PRIVATE',403));assert.equal(writes.at(-1).result,'DENIED');
});

test('source HMAC domains preserve case, link repeated claims and never include credentials or IPs',()=>{
  const a=authenticationRecord(request(),401,key,0),b=authenticationRecord(request(),200,key,0);
  assert.equal(a.accountKey,b.accountKey);
  assert.equal(a.accountKey,createHmac('sha256',Buffer.from(key,'hex')).update('account\0Operator01').digest('hex'));
  assert.equal(a.sourceKey,createHmac('sha256',Buffer.from(key,'hex')).update('source\0'+'192.0.2.1').digest('hex'));
  assert.notEqual(a.accountKey,authenticationRecord(request({body:{loginId:'operator01'}}),401,key,0).accountKey);
  assert.notEqual(a.accountKey,authenticationRecord(request(),401,'cd'.repeat(32),0).accountKey);
  assert.equal(b.event,'authentication_success');
  for(const v of [key,'Operator01','192.0.2.1','PRIVATE-password']) assert.ok(!JSON.stringify(a).includes(v));
});

test('trusted proxy tail is bounded and direct peers cannot spoof their source',()=>{
  const spoof=request({get:()=> '198.51.100.99, 203.0.113.2, 10.0.0.4'});
  assert.equal(authenticationRecord(spoof,401,key,0).sourceKey,authenticationRecord(request(),401,key,0).sourceKey);
  assert.equal(authenticationRecord(spoof,401,key,2).sourceKey,authenticationRecord(request({socket:{remoteAddress:'203.0.113.2'}}),401,key,0).sourceKey);
  assert.equal(authenticationRecord(request({get:()=> 'garbage, 10.0.0.4'}),401,key,2).sourceKey,authenticationRecord(request(),401,key,0).sourceKey);
});

test('authentication reason and logger field allowlists retain source policy',()=>{
  for(const [status,code,reason] of [[401,'UNAUTHORIZED','invalid_credentials'],[429,'RATE_LIMITED','rate_limited'],[403,'ACCOUNT_PENDING','account_pending'],[403,'ACCOUNT_INACTIVE','account_inactive'],[400,'INVALID_REQUEST','invalid_input']]) {
    const record=authenticationRecord(request({securityErrorCode:code}),status,key,0);
    assert.equal(record.reason,reason);
    const safe=logRecord('warn',{...record,password:'PRIVATE',sourceKey:'invalid',rawIp:'PRIVATE'});
    assert.equal(safe.reason,reason);assert.equal(safe.authType,'admin_login');
    assert.ok(!JSON.stringify(safe).includes('PRIVATE'));assert.equal(safe.sourceKey,undefined);
  }
  for(const authType of ['admin_session','ai_business','ai_persona','ai_insights']) {
    const record=authenticationRecord(request({path:'/api/private',securityAuthType:authType}),401,key,0);
    assert.equal(record.authType,authType);
    assert.equal(authenticationRecord(request({path:'/api/private',securityAuthType:authType}),200,key,0),undefined);
  }
});

test('HTTP completion emits one source authentication record without breaking the response',()=>{
  const req=request({get:()=>undefined,route:{path:'/api/auth/login'}}),res=new EventEmitter(),logs=[];
  res.statusCode=401;res.setHeader=()=>{};
  requestContext({log:(v)=>logs.push(v)},{key,proxyHops:0})(req,res,()=>{});
  res.emit('finish');
  assert.deepEqual(logs.map((v)=>v.event),['http_request','authentication_failure']);
  assert.equal(logs[1].requestId,req.requestId);
  assert.doesNotThrow(()=>{const response=new EventEmitter();response.setHeader=()=>{};response.statusCode=401;requestContext({log:()=>{throw Error('down');}},{key,proxyHops:0})(request(),response,()=>{});response.emit('finish');});
});

test('production requires the exact source HMAC key format without exposing rejected values',()=>{
  const base={DB_HOST:'db',DB_USER:'test',DB_PASSWORD:'private',DB_NAME:'test',OPERATIONS_URL:'http://operations:3005',DELIVERY_URL:'http://delivery:3003',CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',CUSTOMER_AUTH_TOKEN:'x'.repeat(48),CONSULTATION_AUTH_TOKEN:'x'.repeat(48)};
  assert.match(validateEnvironment(base).SECURITY_LOG_HMAC_KEY,/^[a-f0-9]{64}$/);
  assert.equal(validateEnvironment({...base,NODE_ENV:'production',SECURITY_LOG_HMAC_KEY:key}).SECURITY_LOG_HMAC_KEY,key);
  for(const value of [undefined,'','PRIVATE',{},'x'.repeat(64),'ab'.repeat(32)+'\n']) assert.throws(()=>validateEnvironment({...base,NODE_ENV:'production',SECURITY_LOG_HMAC_KEY:value}),error=>{
    assert.ok(error.fields.includes('SECURITY_LOG_HMAC_KEY'));assert.ok(!error.message.includes('PRIVATE'));return true;
  });
});
