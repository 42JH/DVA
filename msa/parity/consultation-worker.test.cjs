require('reflect-metadata');
const {before,after,beforeEach,test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {ConfigService}=require('@nestjs/config');
const {createTestPool,startTestApp}=require('./helpers/application.cjs');
const {PbxRecordingWorker}=require('../dist/webhooks/pbx/pbx-recording.worker');
const {PbxWebhookRepository}=require('../dist/webhooks/pbx/pbx-webhook.repository');
const {RecordingStorage}=require('../dist/webhooks/pbx/recording-storage');
const {ConsultationsRepository}=require('../dist/consultations/consultations.repository');
assert.equal(process.env.NODE_ENV,'test');
assert.equal(process.env.DB_NAME,'dva_webhook_test');
assert.equal(process.env.DB_HOST,'127.0.0.1');
process.env.PBX_WEBHOOK_TOKEN='fixture-pbx-token-'.padEnd(48,'p');
process.env.S3_RECORDINGS_BUCKET='';
const pool=createTestPool(),apps=[];
let app,base,config,repository,storage,worker;
const payload=()=>({recordingId:'worker-'+randomUUID(),callFrom:'01098880001',callTo:'07012345678',
  startedAt:'2026-10-27T01:00:00Z',endedAt:'2026-10-27T01:03:00Z',durationSeconds:180,
  recordingUrl:'https://recordings.example.test/audio.mp3?signed=private-test'});
before(async()=>{
  app=await startTestApp(apps);base=await app.getUrl();
  await app.get(PbxRecordingWorker).onModuleDestroy();
  config=app.get(ConfigService);repository=app.get(PbxWebhookRepository);storage=app.get(RecordingStorage);
  worker=new PbxRecordingWorker(repository,storage,config);
});
after(async()=>{await worker?.onModuleDestroy();for(const application of apps)await application.close();await pool.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE pbx_webhooks.call_ended_events,recordings,call_utterances,call_sessions RESTART IDENTITY CASCADE');
  config.set('S3_RECORDINGS_BUCKET','test-recordings');
});
async function call(provider='worker-call',phone='01098880001'){
  return (await pool.query('INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at) VALUES($1,$2,$3) RETURNING call_session_seq',
    [provider,phone,'2026-10-27T01:00:00Z'])).rows[0].call_session_seq;
}
async function receipt(data){
  const response=await fetch(base+'/webhooks/pbx/call-ended',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.PBX_WEBHOOK_TOKEN},body:JSON.stringify(data)});
  assert.equal(response.status,200,await response.text());
  await pool.query("UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '2 minutes' WHERE recording_id=$1",[data.recordingId]);
}
const event=async id=>(await pool.query('SELECT * FROM pbx_webhooks.call_ended_events WHERE recording_id=$1',[id])).rows[0];
test('active count excludes unknown legacy registration, soft deletion and expired calls',async()=>{
  await call('active');await call('legacy');await call('deleted');await call('expired');
  await pool.query("UPDATE call_sessions SET registered_at=NULL WHERE provider_call_id='legacy'; UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE provider_call_id='deleted'; UPDATE call_sessions SET incoming_at=clock_timestamp()-interval '6 years' WHERE provider_call_id='expired'");
  const snapshot=await app.get(ConsultationsRepository).activeCount();
  assert.equal(snapshot.activeCallCount,1);assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
});
test('unmatched and ambiguous calls do not download audio and old unlinked receipts expire',async t=>{
  let downloads=0;t.mock.method(storage,'save',async()=>{downloads++;return'fixture/audio';});
  const missing=payload();await receipt(missing);await worker.processPending();
  assert.equal((await event(missing.recordingId)).call_session_seq,null);assert.equal(downloads,0);
  await call('candidate-one');await call('candidate-two');
  await pool.query("UPDATE pbx_webhooks.call_ended_events SET last_attempt_at=clock_timestamp()-interval '2 minutes' WHERE recording_id=$1",[missing.recordingId]);
  await worker.processPending();assert.equal((await event(missing.recordingId)).call_session_seq,null);assert.equal(downloads,0);
  await pool.query("UPDATE pbx_webhooks.call_ended_events SET received_at=clock_timestamp()-interval '31 minutes' WHERE recording_id=$1",[missing.recordingId]);
  await worker.processPending();assert.equal(await event(missing.recordingId),undefined);assert.equal(downloads,0);
});
test('PBX ends the unique call even while audio storage is unconfigured',async t=>{
  const id=await call(),data=payload();config.set('S3_RECORDINGS_BUCKET','');
  let downloads=0;t.mock.method(storage,'save',async()=>{downloads++;return'fixture/audio';});
  await receipt(data);await worker.processPending();
  const stored=await event(data.recordingId);
  assert.equal(stored.call_session_seq,id);assert.equal(stored.processing_status,'RECEIVED');assert.equal(downloads,0);
  const times=(await pool.query('SELECT started_at,ended_at FROM call_sessions WHERE call_session_seq=$1',[id])).rows[0];
  assert.equal(times.started_at.toISOString(),'2026-10-27T01:00:00.000Z');assert.equal(times.ended_at.toISOString(),'2026-10-27T01:03:00.000Z');
  config.set('S3_RECORDINGS_BUCKET','test-recordings');await worker.processPending();
  assert.equal((await event(data.recordingId)).processing_status,'PROCESSED');assert.equal(downloads,1);
});
test('unknown upload outcome retries the fixed call and stores one recording',async t=>{
  const id=await call(),data=payload();await receipt(data);
  let attempts=0,uploads=0,exists=false;
  t.mock.method(storage,'save',async(recordingId,callId)=>{
    assert.equal(recordingId,data.recordingId);assert.equal(callId,id);attempts++;
    if(!exists){uploads++;exists=true;throw Error('simulated lost upload response');}
    return'fixture/reused-audio';
  });
  await worker.processPending();let stored=await event(data.recordingId);
  assert.equal(stored.processing_status,'FAILED');assert.equal(stored.claim_id,null);assert.equal(stored.call_session_seq,id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM recordings')).rows[0].n,0);
  await pool.query("UPDATE pbx_webhooks.call_ended_events SET last_attempt_at=clock_timestamp()-interval '2 minutes' WHERE recording_id=$1",[data.recordingId]);
  await worker.processPending();stored=await event(data.recordingId);
  assert.equal(stored.processing_status,'PROCESSED');assert.equal(stored.claim_id,null);assert.equal(attempts,2);assert.equal(uploads,1);
  assert.deepEqual((await pool.query('SELECT call_session_seq,object_key FROM recordings')).rows,[{call_session_seq:id,object_key:'fixture/reused-audio'}]);
});
test('competing workers own one claim and stale claims cannot attach audio',async t=>{
  const id=await call(),data=payload();await receipt(data);let saves=0;
  t.mock.method(storage,'save',async()=>{saves++;await new Promise(resolve=>setTimeout(resolve,80));return'fixture/concurrent-audio';});
  const other=new PbxRecordingWorker(repository,storage,config);
  await Promise.all([worker.processPending(),other.processPending()]);
  assert.equal(saves,1);assert.equal((await event(data.recordingId)).processing_status,'PROCESSED');
  assert.equal(await repository.processed(data.recordingId,id,'fixture/stale',randomUUID()),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM recordings')).rows[0].n,1);
  await other.onModuleDestroy();
});
test('a killed claimant leaves a durable lease and recovers only after lease expiry',async t=>{
  const id=await call(),data=payload();await receipt(data);
  const child=spawn(process.execPath,['-e',`
    require('reflect-metadata');const{Pool}=require('pg');
    const{PbxWebhookRepository}=require('./dist/webhooks/pbx/pbx-webhook.repository');
    const pool=new Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
    const repo=new PbxWebhookRepository({pool},{});
    repo.next(true).then(row=>{if(!row)process.exit(2);process.stdout.write(JSON.stringify(row)+'\\n');setInterval(()=>{},1000)}).catch(()=>process.exit(3));
  `],{stdio:['ignore','pipe','pipe'],env:process.env});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}});
  const claim=await new Promise((resolve,reject)=>{
    let text='';const timeout=setTimeout(()=>reject(Error('claim child timed out')),5000);
    child.stdout.on('data',chunk=>{text+=chunk;const end=text.indexOf('\n');if(end>=0){clearTimeout(timeout);resolve(JSON.parse(text.slice(0,end)));}});
    child.once('exit',()=>{clearTimeout(timeout);reject(Error('claim child exited early'));});
  });
  assert.equal(claim.recordingId,data.recordingId);child.kill('SIGKILL');await once(child,'exit');
  let saves=0;t.mock.method(storage,'save',async()=>{saves++;return'fixture/recovered-audio';});
  await worker.processPending();assert.equal(saves,0);assert.equal((await event(data.recordingId)).claim_id,claim.claimId);
  await pool.query("UPDATE pbx_webhooks.call_ended_events SET claimed_until=clock_timestamp()-interval '1 second',last_attempt_at=clock_timestamp()-interval '2 minutes' WHERE recording_id=$1",[data.recordingId]);
  await worker.processPending();assert.equal(saves,1);assert.equal((await event(data.recordingId)).processing_status,'PROCESSED');
  assert.equal(await repository.processed(data.recordingId,id,'fixture/stale-restart',claim.claimId),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM recordings')).rows[0].n,1);
});
