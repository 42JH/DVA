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
const request=(extra={})=>({method:'POST',path:'/api/auth/login',requestId:randomUUID(),body:{loginId:'Operator01',password:'PRIVATE-password'},socket:{remoteAddress:'::ffff:192.0.2.1'},get:()=>undefined,...extra});

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
