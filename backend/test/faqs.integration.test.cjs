require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuditService } = require('../dist/audit/audit.service');
const { FaqsRepository } = require('../dist/faqs/faqs.repository');
const f = require('./helpers/faqs.cjs')();

test('21: all active roles create, view and edit FAQs while AI immediately reads the latest committed text', async () => {
  for (let actor = 0; actor < 3; actor++) {
    const question = f.marker(),
      answer = '첫 문단\n\n- 안내\n\n| 항목 | 설명 |\n| --- | --- |\n| 내용 | 보존 |';
    const id = await f.createdId({ question, answer }, actor);
    const admin = await f.get(`/api/faqs/${id}`, actor);
    assert.equal(admin.status, 200);
    const original = (await admin.json()).data;
    assert.equal(original.question, question);
    assert.equal(original.answer, answer);
    assert.equal(original.updatedByAdminUserSeq, f.ids[actor]);
    assert.ok(original.createdAt);
    const changed = '수정된 답변\n다음 문장';
    const response = await f.patch(id, { answer: changed }, (actor + 1) % 3);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    const ai = await f.ai('/' + id);
    assert.equal(ai.status, 200);
    assert.equal(ai.headers.get('cache-control'), 'no-store');
    const body = await ai.json();
    assert.ok(body.meta.requestId);
    assert.deepEqual(Object.keys(body.data).sort(), [
      'answer',
      'faqEntrySeq',
      'question',
      'updatedAt',
    ]);
    assert.equal(body.data.question, question);
    assert.equal(body.data.answer, changed);
    assert.ok(Date.parse(body.data.updatedAt) >= Date.parse(original.updatedAt));
    const detail = (await (await f.get(`/api/faqs/${id}`)).json()).data;
    assert.equal(detail.createdAt, original.createdAt);
    assert.equal(detail.updatedByAdminUserSeq, f.ids[(actor + 1) % 3]);
    const history = (
      await f.pool.query(
        "SELECT action,actor_seq,metadata FROM audit_logs WHERE target_type='FAQ_ENTRY' AND target_seq=$1 AND result='SUCCESS' ORDER BY audit_log_seq",
        [id],
      )
    ).rows;
    assert.deepEqual(
      history.map((r) => r.action),
      ['FAQ_CREATED', 'FAQ_UPDATED'],
    );
    assert.deepEqual(
      history.map((r) => r.actor_seq),
      [f.ids[actor], f.ids[(actor + 1) % 3]],
    );
    assert.ok(history.every((r) => JSON.stringify(r.metadata) === '{}'));
  }
});

test('21: stable pagination, NFC/case search and literal wildcards return matching questions and answers', async () => {
  const marker = f.marker();
  const ids = [];
  for (const [question, answer] of [
    [`${marker} 가나다`, 'Alpha'],
    [marker, '특수 %_ 문자'],
    [marker, '일반 문자'],
  ])
    ids.push(await f.createdId({ question, answer }));
  const page = async (query, ai = false) => {
    const response = ai
      ? await f.ai('?' + new URLSearchParams(query))
      : await f.get('/api/faqs?' + new URLSearchParams(query));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
    return body;
  };
  const first = await page({ q: marker, limit: '2' });
  assert.deepEqual(
    first.data.map((r) => r.faqEntrySeq),
    ids.slice(0, 2),
  );
  assert.equal(first.hasNext, true);
  const last = await page({ q: marker, limit: '2', offset: '2' }, true);
  assert.deepEqual(
    last.data.map((r) => r.faqEntrySeq),
    ids.slice(2),
  );
  assert.equal(last.hasNext, false);
  assert.equal(Object.hasOwn(last.data[0], 'updatedByAdminUserSeq'), false);
  assert.ok((await page({ q: 'ALPHA' })).data.some((r) => r.faqEntrySeq === ids[0]));
  assert.ok(
    (await page({ q: '가나다'.normalize('NFD') })).data.some((r) => r.faqEntrySeq === ids[0]),
  );
  assert.deepEqual(
    (await page({ q: '%_' })).data.map((r) => r.faqEntrySeq),
    [ids[1]],
  );
  assert.deepEqual(await page({ q: "' OR 1=1; --" }), { data: [], hasNext: false });
});

test('21: partial concurrent edits preserve omitted fields without a version check', async () => {
  const id = await f.createdId({ question: f.marker(), answer: '기존' });
  const results = await Promise.all([
    f.patch(id, { question: '새 질문' }),
    f.patch(id, { answer: '새 답변' }, 1),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [204, 204],
  );
  const { data } = await (await f.ai('/' + id)).json();
  assert.equal(data.question, '새 질문');
  assert.equal(data.answer, '새 답변');
});

test('21: administrator sessions and Origins protect reads and writes; AI cookies cannot bypass authentication', async () => {
  const before = await f.counts();
  await f.error(await f.get('/api/faqs', 0, { Cookie: undefined }), 401, 'UNAUTHORIZED');
  await f.error(
    await f.create({ question: '질문', answer: '답변' }, 0, { Cookie: undefined }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(
    await f.create({ question: '질문', answer: '답변' }, 0, { Origin: undefined }),
    403,
    'FORBIDDEN',
  );
  await f.error(
    await f.create({ question: '질문', answer: '답변' }, 0, { Origin: 'https://foreign.invalid' }),
    403,
    'FORBIDDEN',
  );
  await f.error(await f.ai('', { Cookie: 'dva_session=invalid' }), 401, 'UNAUTHORIZED');
  await f.error(await f.ai('', { Origin: 'https://foreign.invalid' }), 403, 'FORBIDDEN');
  await f.pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [f.ids[0]]);
  try {
    await f.error(await f.get('/api/faqs'), 401, 'UNAUTHORIZED');
  } finally {
    await f.pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
      f.ids[0],
    ]);
  }
  assert.deepEqual(await f.counts(), before);
  await f.error(
    await f.write('POST', '/api/ai/faqs', { question: '질문', answer: '답변' }, 0, {
      Cookie: undefined,
    }),
    404,
    'NOT_FOUND',
  );
});

test('21: invalid bodies, IDs and search parameters fail without changing FAQs', async () => {
  const id = await f.createdId({ question: f.marker(), answer: '답변' });
  const before = await f.counts();
  for (const body of [
    {},
    { question: '' },
    { question: null },
    { answer: null },
    { question: 3 },
    { isEnabled: false },
    { updatedByAdminUserSeq: f.ids[1] },
    { question: 'x\0y' },
  ])
    await f.error(await f.patch(id, body), 400, 'INVALID_REQUEST');
  for (const suffix of [
    '/0',
    '/-1',
    '/1.5',
    '/2147483648',
    '?limit=0',
    '?limit=101',
    '?offset=-1',
    '?q[x]=y',
    '?q=a&q=b',
    '?isEnabled=true',
  ])
    await f.error(await f.ai(suffix), 400, 'INVALID_REQUEST');
  await f.error(await f.ai('/2147483647'), 404, 'NOT_FOUND');
  await f.error(await f.patch(2147483647, { answer: '없음' }), 404, 'NOT_FOUND');
  assert.deepEqual(await f.counts(), before);
});

test('21: audit persistence failure rolls back content and reads never disguise DB failure as an empty FAQ list', async () => {
  const id = await f.createdId({ question: f.marker(), answer: '유지' });
  const before = await f.counts();
  const audit = f.app.get(AuditService),
    record = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw Error('private-faq-audit-failure');
  };
  try {
    await f.error(await f.create({ question: f.marker(), answer: '롤백' }), 500, 'INTERNAL_ERROR');
    await f.error(await f.patch(id, { answer: '롤백' }), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = record;
  }
  assert.deepEqual(await f.counts(), before);
  assert.equal((await (await f.ai('/' + id)).json()).data.answer, '유지');
  const repo = f.app.get(FaqsRepository),
    list = repo.list;
  repo.list = async () => {
    throw Error('private-faq-query-failure');
  };
  try {
    const error = await f.error(await f.ai(), 500, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(error), /private-faq/);
  } finally {
    repo.list = list;
  }
});

test('21: FAQ contents persist across application restarts and HTTP logs omit questions and answers', async () => {
  const secret = f.marker();
  const id = await f.createdId({ question: secret, answer: '비공개 로그 확인 ' + secret });
  await f.ai('?' + new URLSearchParams({ q: secret }));
  const app = await f.start();
  const response = await fetch((await app.getUrl()) + '/api/ai/faqs/' + id);
  assert.equal((await response.json()).data.question, secret);
  assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(secret));
});

test('21: Swagger separates four protected management operations and two read-only AI operations', async () => {
  const spec = await (await fetch(f.base + '/api/docs-json')).json();
  for (const [path, method] of [
    ['/api/faqs', 'get'],
    ['/api/faqs', 'post'],
    ['/api/faqs/{id}', 'get'],
    ['/api/faqs/{id}', 'patch'],
  ])
    assert.deepEqual(spec.paths[path][method].security, [{ adminSession: [] }]);
  for (const path of ['/api/ai/faqs', '/api/ai/faqs/{id}']) {
    assert.deepEqual(Object.keys(spec.paths[path]), ['get']);
    assert.ok(spec.paths[path].get.security.some((s) => Object.keys(s).length === 0));
  }
  assert.ok(spec.paths['/api/faqs'].post.responses['204']);
  assert.equal(
    (spec.paths['/api/faqs'].post.parameters ?? []).some((p) => p.name === 'Idempotency-Key'),
    false,
  );
  const ai = spec.components.schemas.AgentFaqDto;
  assert.equal(ai.properties.updatedByAdminUserSeq, undefined);
  assert.equal(ai.properties.isEnabled, undefined);
  assert.deepEqual(Object.keys(spec.components.schemas.CreateFaqDto.properties).sort(), [
    'answer',
    'question',
  ]);
});
