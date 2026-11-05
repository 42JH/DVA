require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt, randomBytes, createHash } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { RetentionWorker } = require('../dist/retention/retention.worker');
const { RetentionRepository } = require('../dist/retention/retention.repository');
const { PaymentsRepository } = require('../dist/payments/payments.repository');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');
const { OrderPaymentsRepository } = require('../dist/orders/order-payments.repository');
const { RecordingStorage } = require('../dist/webhooks/pbx/recording-storage');
process.env.PBX_WEBHOOK_TOKEN = randomBytes(32).toString('hex');
const { applicationFixture } = require('./helpers/application.cjs');
const f = applicationFixture();
async function oldCall(age = '6 years') {
  const providerCallId = randomUUID(),
    phone = '017' + randomInt(10000000, 99999999);
  const row = (
    await f.pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at)
    SELECT $1,$2,clock_timestamp()-$3::interval,clock_timestamp()-$3::interval,clock_timestamp()-$3::interval+interval '1 minute'
    RETURNING call_session_seq AS id,incoming_at`,
      [providerCallId, phone, age],
    )
  ).rows[0];
  return { ...row, providerCallId, phone };
}
const exists = async (table, key, id) =>
  !!(await f.pool.query(`SELECT 1 FROM ${table} WHERE ${key}=$1`, [id])).rowCount;
const storage = () => f.app.get(RecordingStorage);
const worker = () => f.app.get(RetentionWorker);
const repository = () => f.app.get(RetentionRepository);

async function failedOrder(age = '6 years') {
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    const id = (
      await client.query(
        `INSERT INTO orders(status,payment_method_type,total_amount,created_at,paid_at,pickup_requested_at)
      VALUES('SUBMISSION_FAILED','credit',3500,clock_timestamp()-$1::interval,
        clock_timestamp()-$1::interval,clock_timestamp()-$1::interval) RETURNING order_seq`,
        [age],
      )
    ).rows[0].order_seq;
    await client.query("SELECT set_config('dva.admin_order_edit',$1,true)", [String(id)]);
    await client.query(
      "INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_road_address) VALUES($1,1,'실패 주문 발송인','실패 주문 주소')",
      [id],
    );
    await client.query('COMMIT');
    return id;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('5-year call expiry erases every child in FK order and also removes pre-INSERT upload keys', async (t) => {
  const c = await oldCall(),
    recordingId = randomUUID(),
    key = 'recordings/' + randomUUID();
  await f.pool.query('INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2)', [
    c.id,
    key,
  ]);
  const utterance = (
    await f.pool.query(
      "INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES($1,1,'CUSTOMER','만료 STT',1) RETURNING call_utterance_seq AS id",
      [c.id],
    )
  ).rows[0].id;
  const question = (
    await f.pool.query(
      "INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,reason,payload_hash) VALUES(gen_random_uuid(),$1,'만료 질문',clock_timestamp(),'KB_UNAVAILABLE',repeat('a',64)) RETURNING unanswered_question_seq AS id",
      [c.id],
    )
  ).rows[0].id;
  await f.pool.query(
    `INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,call_utterance_seq,payload_hash)
    VALUES(gen_random_uuid(),$1,1,'UTTERANCE',clock_timestamp(),$2,repeat('b',64))`,
    [c.id, utterance],
  );
  await f.pool.query(
    `INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,unanswered_question_seq,payload,payload_hash)
    VALUES(gen_random_uuid(),$1,2,'BUSINESS_RESULT',clock_timestamp(),$2,'{"action":"QUESTION_UNANSWERED"}',repeat('c',64))`,
    [c.id, question],
  );
  await f.pool.query(
    "INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,complaints,payload_hash,has_callback_request) VALUES($1,clock_timestamp(),clock_timestamp(),'[]',repeat('d',64),true)",
    [c.id],
  );
  await f.pool.query(
    'INSERT INTO empty_ai_order_results(request_id,call_session_seq) VALUES(gen_random_uuid(),$1)',
    [c.id],
  );
  await f.pool.query(
    "INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq) VALUES($1,'{}',$2)",
    [recordingId, c.id],
  );
  const erased = [];
  t.mock.method(storage(), 'erase', async (value) => {
    erased.push(value);
  });
  await worker().run();
  assert.deepEqual(
    erased.sort(),
    [key, 'recordings/' + createHash('sha256').update(recordingId).digest('hex')].sort(),
  );
  for (const table of [
    'call_sessions',
    'call_insight_events',
    'unanswered_questions',
    'call_utterances',
    'call_analyses',
    'recordings',
    'empty_ai_order_results',
  ])
    assert.equal(await exists(table, 'call_session_seq', c.id), false, table);
  assert.equal(await exists('pbx_webhooks.call_ended_events', 'recording_id', recordingId), false);
});

test('S3 failures retain keys for retry, release DB locks before external requests and fence concurrent workers', async (t) => {
  const c = await oldCall(),
    key = 'recordings/' + randomUUID();
  await f.pool.query('INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2)', [
    c.id,
    key,
  ]);
  let fail = true,
    calls = 0;
  t.mock.method(storage(), 'erase', async (value) => {
    assert.equal(value, key);
    calls++;
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      assert.equal(
        (
          await client.query(
            'SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE NOWAIT',
            [c.id],
          )
        ).rowCount,
        1,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    if (fail) throw Error('simulated-storage-denial');
  });
  await worker().run();
  assert.equal(calls, 1);
  assert.equal(await exists('call_sessions', 'call_session_seq', c.id), true);
  await f.error(await f.get('/api/calls/' + c.id), 404, 'NOT_FOUND');
  assert.equal(
    (await f.pool.query('SELECT object_key FROM recordings WHERE call_session_seq=$1', [c.id]))
      .rows[0].object_key,
    key,
  );
  await f.pool.query(
    "UPDATE call_sessions SET purge_claimed_until=clock_timestamp()-interval '1 second' WHERE call_session_seq=$1",
    [c.id],
  );
  fail = false;
  const other = new RetentionWorker(
    repository(),
    storage(),
    new ConfigService({ NODE_ENV: 'test' }),
  );
  await Promise.all([worker().run(), other.run()]);
  assert.equal(calls, 2);
  assert.equal(await exists('call_sessions', 'call_session_seq', c.id), false);
});

test('an active PBX upload lease blocks expiry until release and cannot be reclaimed by the recording worker', async (t) => {
  const c = await oldCall(),
    recordingId = randomUUID();
  await f.pool.query(
    `INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq,claim_id,claimed_until)
    VALUES($1,'{}',$2,gen_random_uuid(),clock_timestamp()+interval '5 minutes')`,
    [recordingId, c.id],
  );
  let erased = 0;
  t.mock.method(storage(), 'erase', async () => {
    erased++;
  });
  await worker().run();
  assert.equal(erased, 0);
  assert.equal(await exists('call_sessions', 'call_session_seq', c.id), true);
  await f.pool.query(
    'UPDATE pbx_webhooks.call_ended_events SET claim_id=NULL,claimed_until=NULL WHERE recording_id=$1',
    [recordingId],
  );
  await worker().run();
  assert.equal(erased, 1);
  assert.equal(await exists('call_sessions', 'call_session_seq', c.id), false);
});

test('incoming_at is the sole call retention clock; 7-day cleanup preserves business AI events and pending notifications', async () => {
  const c = await oldCall('4 years');
  await f.pool.query(
    "INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,occurred_at,payload,payload_hash,received_at) VALUES(gen_random_uuid(),$1,1,'AI_ACTION',clock_timestamp(),'{}',repeat('a',64),clock_timestamp()-interval '8 days')",
    [c.id],
  );
  await f.pool.query(
    "UPDATE call_sessions SET started_at=incoming_at-interval '2 years',ended_at=incoming_at WHERE call_session_seq=$1",
    [c.id],
  );
  const auditIds = [];
  for (const age of ['8 days', '6 days'])
    auditIds.push(
      (
        await f.pool.query(
          "INSERT INTO audit_logs(actor_type,action,target_type,request_id,result,metadata,occurred_at) VALUES('SYSTEM','RETENTION_TEST','SYSTEM',gen_random_uuid(),'SUCCESS','{}',clock_timestamp()-$1::interval) RETURNING audit_log_seq AS id",
          [age],
        )
      ).rows[0].id,
    );
  const notes = [];
  for (const age of ['8 days', '6 days', null])
    notes.push(
      (
        await f.pool.query(
          "INSERT INTO faq_change_notifications(operation,faq_entry_seqs,request_id,created_at,sent_at) VALUES('DELETE',ARRAY[2147483647],gen_random_uuid(),clock_timestamp()-interval '30 days',CASE WHEN $1::text IS NOT NULL THEN clock_timestamp()-$1::interval END) RETURNING faq_change_notification_seq AS id",
          [age],
        )
      ).rows[0].id,
    );
  await worker().run();
  assert.equal(await exists('call_sessions', 'call_session_seq', c.id), true);
  assert.equal(await exists('call_insight_events', 'call_session_seq', c.id), true);
  assert.equal(await exists('audit_logs', 'audit_log_seq', auditIds[0]), false);
  assert.equal(await exists('audit_logs', 'audit_log_seq', auditIds[1]), true);
  assert.equal(
    await exists('faq_change_notifications', 'faq_change_notification_seq', notes[0]),
    false,
  );
  assert.equal(
    await exists('faq_change_notifications', 'faq_change_notification_seq', notes[1]),
    true,
  );
  assert.equal(
    await exists('faq_change_notifications', 'faq_change_notification_seq', notes[2]),
    true,
  );
});

test('expired accepted orders purge finalized parcels, shipments, payments and charges without recalculating retained billing totals', async () => {
  const org = randomInt(10000000, 99999999);
  const client = await f.pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    id = (
      await client.query(
        `INSERT INTO orders(status,payment_method_type,total_amount,created_at,closed_at,paid_at,pickup_requested_at,parcel_no,dver_received_at,billing_organization_seq)
      VALUES('ACCEPTED','credit',5000,clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years','OLD00157',clock_timestamp()-interval '6 years',$1) RETURNING order_seq`,
        [org],
      )
    ).rows[0].order_seq;
    await client.query("SELECT set_config('dva.admin_order_edit',$1,true)", [String(id)]);
    const parcel = (
      await client.query(
        "INSERT INTO order_parcels(order_seq,parcel_position,origin_name) VALUES($1,1,'만료 주소 스냅샷') RETURNING order_parcel_seq",
        [id],
      )
    ).rows[0].order_parcel_seq;
    const shipment = (
      await client.query(
        "INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,$2,'paid') RETURNING shipment_seq",
        [parcel, randomUUID()],
      )
    ).rows[0].shipment_seq;
    await client.query(
      "INSERT INTO shipment_status_history(shipment_seq,request_id,to_status,actor_type) VALUES($1,gen_random_uuid(),'paid','SYSTEM')",
      [shipment],
    );
    await client.query(
      "INSERT INTO order_payment_requests(order_seq,amount,expires_at,invalidated_at) VALUES($1,5000,clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years')",
      [id],
    );
    await client.query(
      "INSERT INTO order_billing_charges(order_seq,organization_seq,billing_month,payment_method_type,amount,occurred_at) VALUES($1,$2,'2020-01-01','credit',5000,clock_timestamp()-interval '6 years')",
      [id, org],
    );
    await client.query(
      "INSERT INTO organization_billing_months(organization_seq,billing_month,organization_name,monthly_amount) VALUES($1,date_trunc('month',clock_timestamp()),'보존 청구',7777)",
      [org],
    );
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  await assert.rejects(f.pool.query('DELETE FROM order_parcels WHERE order_seq=$1', [id]), {
    code: '23514',
  });
  await f.error(await f.get('/api/orders/' + id), 404, 'NOT_FOUND');
  await worker().run();
  for (const table of [
    'orders',
    'order_parcels',
    'order_payment_requests',
    'order_billing_charges',
  ])
    assert.equal(await exists(table, 'order_seq', id), false, table);
  assert.equal(
    Number(
      (
        await f.pool.query(
          'SELECT monthly_amount FROM organization_billing_months WHERE organization_seq=$1',
          [org],
        )
      ).rows[0].monthly_amount,
    ),
    7777,
  );
});

test('expired final submission failures purge their snapshots and completed payment while newer failures remain', async () => {
  const expired = await failedOrder(),
    boundary = await failedOrder('5 years'),
    newer = await failedOrder('5 years -1 hour');
  await f.pool.query(
    `INSERT INTO order_payment_requests(order_seq,amount,expires_at,completed_at,provider_reference,
      provider_payment_key,provider_approved_at,completion_notification_status)
    VALUES($1,3500,clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years',
      $2,$2,clock_timestamp()-interval '6 years','SENT')`,
    [expired, randomUUID()],
  );
  await f.error(await f.get('/api/orders/' + expired), 404, 'NOT_FOUND');
  await worker().run();
  for (const id of [expired, boundary]) {
    for (const table of ['orders', 'order_parcels', 'order_payment_requests'])
      assert.equal(await exists(table, 'order_seq', id), false, table + ':' + id);
  }
  assert.equal(await exists('orders', 'order_seq', newer), true);
  assert.equal(await exists('order_parcels', 'order_seq', newer), true);
});

test('expired final submission failures retain active payment, notification and linked-call protections', async (t) => {
  for (const reason of ['approval', 'notification', 'completion', 'call']) {
    await t.test(reason, async () => {
      const id = await failedOrder();
      if (reason === 'call') {
        await f.pool.query(
          'INSERT INTO call_sessions(provider_call_id,order_seq,incoming_at) VALUES($1,$2,clock_timestamp())',
          [randomUUID(), id],
        );
      } else {
        await f.pool.query(
          `INSERT INTO order_payment_requests(order_seq,amount,expires_at,
            approval_started_at,provider_payment_key,completed_at,provider_reference,
            notification_status,completion_notification_status,approval_claim_id,approval_claimed_until,
            notification_attempted_at,completion_notification_attempted_at)
          VALUES($1,3500,clock_timestamp()-interval '6 years',
            CASE WHEN $2='approval' THEN clock_timestamp() END,
            CASE WHEN $2='approval' THEN $3 END,
            CASE WHEN $2='completion' THEN clock_timestamp()-interval '6 years' END,
            CASE WHEN $2='completion' THEN $3 END,
            CASE WHEN $2='notification' THEN 'SENDING' ELSE 'SENT' END,
            CASE WHEN $2='completion' THEN 'SENDING' ELSE 'WAITING' END,
            CASE WHEN $2='approval' THEN gen_random_uuid() END,
            CASE WHEN $2='approval' THEN clock_timestamp()+interval '45 seconds' END,
            CASE WHEN $2='notification' THEN clock_timestamp() END,
            CASE WHEN $2='completion' THEN clock_timestamp() END)`,
          [id, reason, randomUUID()],
        );
      }
      await repository().purgeDatabase();
      assert.equal(await exists('orders', 'order_seq', id), true);
      assert.equal(await exists('order_parcels', 'order_seq', id), true);
      // Release only this fixture's blocker and verify that expiry then removes it.
      if (reason === 'call') {
        await f.pool.query('UPDATE call_sessions SET order_seq=NULL WHERE order_seq=$1', [id]);
      } else if (reason === 'approval') {
        await f.pool.query(
          'UPDATE order_payment_requests SET approval_claim_id=NULL,approval_claimed_until=NULL WHERE order_seq=$1',
          [id],
        );
      } else {
        await f.pool.query(
          "UPDATE order_payment_requests SET notification_status='SENT',completion_notification_status=CASE WHEN completed_at IS NULL THEN 'WAITING' ELSE 'SENT' END WHERE order_seq=$1",
          [id],
        );
      }
      await repository().purgeDatabase();
      assert.equal(await exists('orders', 'order_seq', id), false);
      assert.equal(await exists('order_parcels', 'order_seq', id), false);
    });
  }
});

test('expired abandoned payment and submission states purge while current work remains', async () => {
  const expired = [],
    retained = [];
  for (const status of ['PAID', 'SUBMITTING', 'SUBMITTING_FAILED']) {
    for (const age of ['6 years', '4 years']) {
      const row = (
        await f.pool.query(
          `INSERT INTO orders(status,payment_method_type,total_amount,created_at,paid_at,pickup_requested_at,updated_at)
      VALUES($1,'credit',3500,clock_timestamp()-$2::interval,
        clock_timestamp()-$2::interval,clock_timestamp()-$2::interval,clock_timestamp()-$2::interval) RETURNING order_seq`,
          [status, age],
        )
      ).rows[0];
      (age === '6 years' ? expired : retained).push(row.order_seq);
    }
  }
  const active = await failedOrder();
  await f.pool.query(
    "UPDATE orders SET status='SUBMITTING',submission_last_attempt_at=clock_timestamp() WHERE order_seq=$1",
    [active],
  );
  await repository().purgeDatabase();
  for (const id of expired) assert.equal(await exists('orders', 'order_seq', id), false);
  for (const id of [...retained, active])
    assert.equal(await exists('orders', 'order_seq', id), true);
  await f.pool.query(
    "UPDATE orders SET submission_last_attempt_at=clock_timestamp()-interval '11 seconds' WHERE order_seq=$1",
    [active],
  );
  await repository().purgeDatabase();
  assert.equal(await exists('orders', 'order_seq', active), false);
});

test('expired unresolved payments leave recovery and purge without releasing retained payment keys', async () => {
  const requests = [];
  for (const age of ['6 years', '4 years']) {
    const id = (
      await f.pool.query(
        `INSERT INTO orders(status,payment_method_type,total_amount,created_at,payment_due_at)
      VALUES('notPaid','billing',3500,clock_timestamp()-$1::interval,clock_timestamp()-$1::interval+interval '1 day') RETURNING order_seq`,
        [age],
      )
    ).rows[0].order_seq;
    const request = (
      await f.pool.query(
        `INSERT INTO order_payment_requests(order_seq,amount,created_at,expires_at,provider_payment_key,approval_started_at)
      VALUES($1,3500,clock_timestamp()-$2::interval,clock_timestamp()-$2::interval+interval '1 day',$3,clock_timestamp()-$2::interval)
      RETURNING payment_request_id AS id,provider_payment_key AS key`,
        [id, age, randomUUID()],
      )
    ).rows[0];
    requests.push({ ...request, orderId: id });
  }
  const [expired, retained] = requests;
  assert.equal(
    await f.app
      .get(OrderPaymentsRepository)
      .reserveApproval(f.pool, expired.id, expired.key, randomUUID()),
    false,
  );
  const candidates = await f.app.get(PaymentsRepository).pendingApprovals();
  assert.equal(
    candidates.some((row) => row.id === expired.id),
    false,
  );
  assert.equal(
    candidates.some((row) => row.id === retained.id),
    true,
  );
  await assert.rejects(
    f.app.get(OrderPaymentsService).claimApproval(expired.id, 3500, expired.key),
    (error) => error.getStatus() === 404,
  );
  await repository().purgeDatabase();
  assert.equal(await exists('orders', 'order_seq', expired.orderId), false);
  assert.equal(await exists('order_payment_requests', 'payment_request_id', expired.id), false);
  const kept = (
    await f.pool.query(
      'SELECT provider_payment_key,approval_started_at FROM order_payment_requests WHERE payment_request_id=$1',
      [retained.id],
    )
  ).rows[0];
  assert.equal(kept.provider_payment_key, retained.key);
  assert.ok(kept.approval_started_at);
});

test('expired stale notification states do not hold payment data indefinitely', async (t) => {
  for (const kind of ['notification', 'completion'])
    await t.test(kind, async () => {
      const id = await failedOrder();
      await f.pool.query(
        `INSERT INTO order_payment_requests(order_seq,amount,expires_at,completed_at,provider_reference,
      notification_status,notification_attempted_at,completion_notification_status,completion_notification_attempted_at)
      VALUES($1,3500,clock_timestamp()-interval '6 years',CASE WHEN $2='completion' THEN clock_timestamp()-interval '6 years' END,
      CASE WHEN $2='completion' THEN $3 END,CASE WHEN $2='notification' THEN 'SENDING' ELSE 'SENT' END,
      clock_timestamp()-interval '46 seconds',CASE WHEN $2='completion' THEN 'SENDING' ELSE 'WAITING' END,clock_timestamp()-interval '46 seconds')`,
        [id, kind, randomUUID()],
      );
      await repository().purgeDatabase();
      assert.equal(await exists('orders', 'order_seq', id), false);
      assert.equal(await exists('order_payment_requests', 'order_seq', id), false);
    });
});

test('master data expiry erases personal details while preserving newer order FKs and clears old persona author names', async () => {
  const customer = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status,deleted_at) VALUES('만료 개인정보',$1,'WITHDRAWN',clock_timestamp()-interval '6 years') RETURNING customer_seq",
      ['016' + randomInt(10000000, 99999999)],
    )
  ).rows[0].customer_seq;
  const order = (
    await f.pool.query(
      "INSERT INTO orders(customer_seq,status) VALUES($1,'COLLECTING') RETURNING order_seq",
      [customer],
    )
  ).rows[0].order_seq;
  const persona = (
    await f.pool.query('INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq', [
      randomUUID(),
    ])
  ).rows[0].ai_persona_seq;
  await f.pool.query(
    "INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level,created_at,created_by_admin_user_name) VALUES($1,1,'과거 설정','프롬프트','NORMAL',clock_timestamp()-interval '6 years','만료 작성자')",
    [persona],
  );
  await worker().run();
  const row = (
    await f.pool.query(
      'SELECT name,phone_number,address_data,anonymized_at FROM customers WHERE customer_seq=$1',
      [customer],
    )
  ).rows[0];
  assert.equal(row.name, '삭제된 고객');
  assert.equal(row.phone_number, '000' + customer);
  assert.equal(row.address_data, null);
  assert.ok(row.anonymized_at);
  assert.equal(
    (await f.pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [order])).rows[0]
      .customer_seq,
    customer,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT created_by_admin_user_name FROM ai_persona_versions WHERE ai_persona_seq=$1',
        [persona],
      )
    ).rows[0].created_by_admin_user_name,
    null,
  );
});

test('late expired PBX and AI registration cannot repopulate erased data', async () => {
  const c = await oldCall();
  await worker().run();
  assert.equal(await exists('call_sessions', 'call_session_seq', c.id), false);
  const replay = await f.write(
    'POST',
    '/api/customers/context',
    {
      phoneNumber: c.phone,
      call: { providerCallId: c.providerCallId, incomingAt: c.incoming_at.toISOString() },
    },
    0,
    { Cookie: undefined, Origin: undefined },
  );
  await f.error(replay, 409, 'INVALID_STATE');
  const recordingId = randomUUID();
  const response = await fetch(f.base + '/webhooks/pbx/call-ended', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.PBX_WEBHOOK_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recordingId,
      callFrom: c.phone,
      callTo: '07012345678',
      startedAt: c.incoming_at.toISOString(),
      endedAt: new Date(c.incoming_at.getTime() + 60_000).toISOString(),
      durationSeconds: 60,
      recordingUrl: 'https://example.invalid/expired.mp3',
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).status, 'expired');
  assert.equal(await exists('pbx_webhooks.call_ended_events', 'recording_id', recordingId), false);
});

test('expiry queries use time index bounds instead of filtering growing unexpired history', async (t) => {
  const statements = [];
  const query = async (sql) => {
    statements.push(sql);
    return { rows: sql.includes(' AS locked') ? [{ locked: true }] : [] };
  };
  const captured = new RetentionRepository({
    pool: { query },
    transaction: (work) => work({ query }),
  });
  await captured.claimCall();
  await captured.purgeDatabase();
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO audit_logs(actor_type,action,target_type,request_id,result,metadata)
      SELECT 'SYSTEM','RETENTION_PLAN','SYSTEM',gen_random_uuid(),'SUCCESS','{}' FROM generate_series(1,20000)`);
    await client.query(`INSERT INTO faq_change_notifications(operation,faq_entry_seqs,request_id,sent_at)
      SELECT 'DELETE',ARRAY[2147483647],gen_random_uuid(),clock_timestamp() FROM generate_series(1,2000)`);
    await client.query(`INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
      SELECT gen_random_uuid()::text,clock_timestamp(),clock_timestamp(),clock_timestamp() FROM generate_series(1,2000)`);
    await client.query(`INSERT INTO orders(status)
      SELECT 'COLLECTING' FROM generate_series(1,2000)`);
    await client.query('ANALYZE audit_logs,faq_change_notifications,call_sessions,orders');
    for (const [prefix, index] of [
      ['DELETE FROM audit_logs', 'audit_logs_retention_idx'],
      ['DELETE FROM faq_change_notifications', 'faq_notifications_retention_idx'],
      ['SELECT call_session_seq AS id', 'call_sessions_retention_idx'],
      ['SELECT o.order_seq AS id', 'orders_retention_idx'],
    ]) {
      const sql = statements.find((sql) => sql.startsWith(prefix));
      assert.ok(sql, prefix);
      const plan = (await client.query('EXPLAIN (ANALYZE,FORMAT JSON) ' + sql)).rows[0][
        'QUERY PLAN'
      ][0];
      const pending = [plan.Plan];
      let scan;
      while (pending.length) {
        const node = pending.pop();
        if (node['Index Name'] === index) scan = node;
        pending.push(...(node.Plans ?? []));
      }
      assert.ok(scan, index + ': ' + JSON.stringify(plan.Plan));
      assert.match(scan['Index Cond'] ?? '', /<=/, index + ' must bound the expiry range');
      t.diagnostic(
        `${index}: ${scan['Index Cond']}; ${scan['Rows Removed by Filter'] ?? 0} rows filtered; ${plan['Execution Time']} ms`,
      );
    }
  } finally {
    try {
      await client.query('ROLLBACK');
      await client.query('ANALYZE audit_logs,faq_change_notifications,call_sessions,orders');
    } finally {
      client.release();
    }
  }
});
