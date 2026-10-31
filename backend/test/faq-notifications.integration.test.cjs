require('reflect-metadata');
const { before, beforeEach, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { ConfigService } = require('@nestjs/config');
const { isUUID } = require('class-validator');
const { DatabaseService } = require('../dist/database/database.service');
const { AuditService } = require('../dist/audit/audit.service');
const { FaqNotificationsRepository } = require('../dist/faqs/faq-notifications.repository');
const { FaqNotificationsWorker } = require('../dist/faqs/faq-notifications.worker');
const f = require('./helpers/faqs.cjs')();
const token = 'faq-notification-test-token-at-least-32-characters';
const requests = [];
let ai,
  aiUrl,
  config,
  worker,
  status = 202,
  hang = false;
const rows = async () =>
  (
    await f.pool.query(
      'SELECT * FROM faq_change_notifications ORDER BY faq_change_notification_seq',
    )
  ).rows;
const due = () =>
  f.pool.query(
    "UPDATE faq_change_notifications SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE sent_at IS NULL",
  );
before(async () => {
  ai = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/internal/faqs/refresh');
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let input = '';
    for await (const part of request) input += part;
    const body = JSON.parse(input);
    assert.deepEqual(Object.keys(body).sort(), ['eventId', 'faqEntrySeqs', 'operation']);
    assert.ok(isUUID(body.eventId));
    requests.push(body);
    if (hang) return;
    if (status === 307) response.setHeader('Location', aiUrl + '/untrusted');
    response.writeHead(status);
    response.end();
  });
  await new Promise((resolve) => ai.listen(0, '127.0.0.1', resolve));
  aiUrl = `http://127.0.0.1:${ai.address().port}`;
});
beforeEach(async () => {
  // fixture가 검사한 임시 DB에서만 알림 사례를 독립시킨다.
  await f.pool.query('DELETE FROM faq_change_notifications');
  requests.length = 0;
  status = 202;
  hang = false;
  config = f.app.get(ConfigService);
  config.set('AI_AGENT_URL', aiUrl);
  config.set('AI_FAQ_TOKEN', token);
  worker = f.app.get(FaqNotificationsWorker);
});
after(async () => {
  ai.closeAllConnections();
  await new Promise((resolve) => ai.close(resolve));
});

test('FAQ changes queue one notification per request, preserve deleted IDs, and audit delivery as SYSTEM', async () => {
  const marker = f.marker();
  assert.equal(
    (
      await f.create({
        items: [
          { category: '기타', question: marker + '1', answer: '답변' },
          { category: '기타', question: marker + '2', answer: '답변' },
        ],
      })
    ).status,
    204,
  );
  const ids = (await (await f.ai('?q=' + marker)).json()).data.map((row) => row.faqEntrySeq);
  assert.equal((await rows()).length, 1);
  assert.equal(requests.length, 0);
  assert.equal(
    (await f.patch(ids[0], { category: '기타', question: marker + '1', answer: '수정' })).status,
    204,
  );
  assert.equal((await f.write('DELETE', '/api/faqs', { faqEntrySeqs: ids })).status, 204);
  const events = await rows();
  assert.deepEqual(
    events.map((row) => row.operation),
    ['INSERT', 'UPDATE', 'DELETE'],
  );
  assert.deepEqual(
    events.map((row) => row.faq_entry_seqs),
    [ids, [ids[0]], ids],
  );
  for (let i = 0; i < 3; i++) await worker.run();
  assert.deepEqual(
    requests.map((row) => row.operation),
    ['INSERT', 'UPDATE', 'DELETE'],
  );
  assert.ok(
    (await rows()).every(
      (row) => row.sent_at !== null && row.attempts === 1 && row.claim_id === null,
    ),
  );
  const logs = (
    await f.pool.query(
      "SELECT action,actor_type,result FROM audit_logs WHERE target_type='FAQ_CHANGE_NOTIFICATION' AND target_seq=ANY($1::int[]) ORDER BY audit_log_seq",
      [events.map((row) => row.faq_change_notification_seq)],
    )
  ).rows;
  assert.deepEqual(
    logs.map((row) => row.action),
    Array(3).fill(['FAQ_NOTIFICATION_ATTEMPTED', 'FAQ_NOTIFICATION_SENT']).flat(),
  );
  assert.ok(logs.every((row) => row.actor_type === 'SYSTEM' && row.result === 'SUCCESS'));
});

test('missing configuration retains notifications and FAQ writes; rollback never leaves an event or sends HTTP', async () => {
  config.set('AI_FAQ_TOKEN', '');
  await f.createdId({ category: '기타', question: f.marker(), answer: '설정 없이도 저장' });
  await worker.run();
  assert.equal(requests.length, 0);
  assert.equal((await rows())[0].attempts, 0);
  const database = f.app.get(DatabaseService),
    transaction = database.transaction;
  const before = await f.counts();
  database.transaction = (work) =>
    transaction.call(database, async (client) => {
      await work(client);
      throw Error('private-faq-after-queue-rollback');
    });
  try {
    await f.error(
      await f.create({ items: [{ category: '기타', question: f.marker(), answer: '롤백' }] }),
      500,
      'INTERNAL_ERROR',
    );
  } finally {
    database.transaction = transaction;
  }
  assert.deepEqual(await f.counts(), before);
  assert.equal(requests.length, 0);
});

test('uncommitted content and its notification cannot be observed by the delivery worker', async () => {
  const audit = f.app.get(AuditService),
    record = audit.recordSuccess;
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  audit.recordSuccess = async (...args) => {
    if (args[0].action === 'FAQ_CREATED') {
      entered();
      await gate;
    }
    return record.apply(audit, args);
  };
  const creating = f.create({
    items: [{ category: '기타', question: f.marker(), answer: '커밋 후 전송' }],
  });
  try {
    await ready;
    await worker.run();
    assert.equal((await rows()).length, 0);
    assert.equal(requests.length, 0);
  } finally {
    release();
    audit.recordSuccess = record;
  }
  assert.equal((await creating).status, 204);
  await worker.run();
  assert.equal(requests.length, 1);
});

test('failures retry the same event after backoff and later notifications never overtake it', async () => {
  for (let i = 0; i < 2; i++)
    await f.createdId({ category: '기타', question: f.marker(), answer: '유지' });
  status = 400;
  await worker.run();
  let pending = await rows();
  assert.equal(pending[0].sent_at, null);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[1].attempts, 0);
  assert.ok(pending[0].next_attempt_at > pending[0].created_at);
  await worker.run();
  assert.equal(requests.length, 1);
  await due();
  status = 202;
  await worker.run();
  await worker.run();
  assert.equal(requests[0].eventId, requests[1].eventId);
  assert.notEqual(requests[1].eventId, requests[2].eventId);
  pending = await rows();
  assert.ok(pending.every((row) => row.sent_at !== null));
  const log = (
    await f.pool.query(
      "SELECT actor_type,result FROM audit_logs WHERE target_type='FAQ_CHANGE_NOTIFICATION' AND target_seq=$1 AND action='FAQ_NOTIFICATION_FAILED'",
      [pending[0].faq_change_notification_seq],
    )
  ).rows;
  assert.deepEqual(log, [{ actor_type: 'SYSTEM', result: 'FAILED' }]);
});

test('server errors, redirects and timeouts retain the same notification and do not expose its contents', async () => {
  await f.createdId({
    category: '기타',
    question: f.marker(),
    answer: '본문은 알림에 포함하지 않음',
  });
  for (const code of [500, 307, 200]) {
    status = code;
    await worker.run();
    assert.equal((await rows())[0].sent_at, null);
    await due();
  }
  hang = true;
  await worker.run();
  hang = false;
  const pending = (await rows())[0];
  assert.equal(pending.sent_at, null);
  assert.equal(pending.attempts, 4);
  assert.equal(new Set(requests.map((row) => row.eventId)).size, 1);
});

test('another backend instance resumes a pending event with its original event ID', async () => {
  await f.createdId({ category: '기타', question: f.marker(), answer: '재시작 보존' });
  status = 400;
  await worker.run();
  await due();
  process.env.AI_FAQ_TOKEN = '';
  const app = await f.start();
  app.get(ConfigService).set('AI_AGENT_URL', aiUrl);
  app.get(ConfigService).set('AI_FAQ_TOKEN', token);
  status = 202;
  await app.get(FaqNotificationsWorker).run();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].eventId, requests[1].eventId);
  assert.ok((await rows())[0].sent_at);
});

test('concurrent instances claim one event; expired claims recover and stale owners cannot complete it', async () => {
  await f.createdId({ category: '기타', question: f.marker(), answer: '중복 점유 방지' });
  process.env.AI_FAQ_TOKEN = '';
  const app = await f.start();
  app.get(ConfigService).set('AI_AGENT_URL', aiUrl);
  app.get(ConfigService).set('AI_FAQ_TOKEN', token);
  await Promise.all([worker.run(), worker.run(), app.get(FaqNotificationsWorker).run()]);
  assert.equal(requests.length, 1);
  await f.createdId({ category: '기타', question: f.marker(), answer: '점유 후 중단' });
  const repo = f.app.get(FaqNotificationsRepository);
  const first = await repo.claim();
  assert.ok(first);
  assert.equal(await repo.claim(), undefined);
  await f.pool.query(
    "UPDATE faq_change_notifications SET claimed_until=clock_timestamp()-interval '1 second' WHERE faq_change_notification_seq=$1",
    [first.id],
  );
  const second = await repo.claim();
  assert.equal(second.eventId, first.eventId);
  assert.notEqual(second.claimId, first.claimId);
  await repo.finish(first, true);
  assert.equal((await rows()).at(-1).sent_at, null);
  await repo.finish(second, true);
  assert.ok((await rows()).at(-1).sent_at);
});

test('notification audit failure rolls back a claim so no HTTP is sent and the next attempt can recover', async () => {
  await f.createdId({ category: '기타', question: f.marker(), answer: '감사와 점유 원자성' });
  const audit = f.app.get(AuditService),
    record = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw Error('private-notification-audit-failure');
  };
  try {
    await worker.run();
  } finally {
    audit.recordSuccess = record;
  }
  assert.equal(requests.length, 0);
  assert.equal((await rows())[0].attempts, 0);
  await worker.run();
  assert.equal(requests.length, 1);
  assert.ok((await rows())[0].sent_at);
});

test('database constraints forbid empty/multiple-update event payloads and incoherent claims', async () => {
  for (const [operation, ids] of [
    ['INSERT', []],
    ['UPDATE', [1, 2]],
    ['DELETE', [0]],
    ['DELETE', [null]],
  ])
    await assert.rejects(
      () =>
        f.pool.query(
          'INSERT INTO faq_change_notifications(operation,faq_entry_seqs,request_id) VALUES($1,$2,$3)',
          [operation, ids, randomUUID()],
        ),
      (error) => error.code === '23514',
    );
  await f.createdId({ category: '기타', question: f.marker(), answer: '점유 제약' });
  await assert.rejects(
    () => f.pool.query('UPDATE faq_change_notifications SET claim_id=$1', [randomUUID()]),
    (error) => error.code === '23514',
  );
});
