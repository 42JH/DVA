const customerAddress = require('./helpers/customer-address.cjs');
const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const businessHeaders = () => ({ Authorization: 'Bearer ' + process.env.TEST_BUSINESS_TOKEN });

const { setTimeout: delay } = require('node:timers/promises');

test('persona runtime reads and acknowledgment authentication survive real Nginx forwarding', async () => {
  const headers = { Authorization: `Bearer ${process.env.TEST_PERSONA_TOKEN}` };
  const active = await fetch('http://proxy/api/ai/config', { headers });
  assert.equal(active.status, 200, await active.clone().text());
  assert.equal(active.headers.get('cache-control'), 'no-store');
  const { data } = await active.json();
  assert.equal(data.status, 'ACTIVE');
  const body = JSON.stringify({
    aiPersonaVersionSeq: data.aiPersonaVersionSeq,
    applicationId: data.applicationId,
    activeCallCount: 0,
    result: 'APPLIED',
  });
  const duplicate = await fetch('http://proxy/api/ai/config/apply-result', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(duplicate.status, 200, await duplicate.clone().text());
  assert.equal((await duplicate.json()).data.appliedAt, data.appliedAt);
  const denied = await fetch('http://proxy/api/ai/config/apply-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'UNAUTHORIZED');
  assert.equal((await fetch('http://proxy/api/personas', { headers })).status, 401);
});

test('production FAQ management through Nginx updates the AI read API without exposing admin metadata', async () => {
  const root = 'http://proxy/api';
  const origin = 'https://13.209.59.180';
  const login = await fetch(root + '/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const headers = {
    Origin: origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const question = 'runtime-faq-' + randomUUID();
  const missingCategory = await fetch(root + '/faqs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: [{ question, answer: '분류 누락' }] }),
  });
  assert.equal(missingCategory.status, 400, await missingCategory.clone().text());
  const created = await fetch(root + '/faqs', {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: [{ category: '접수', question, answer: '초기 답변' }] }),
  });
  assert.equal(created.status, 204);
  assert.equal(await created.text(), '');
  const location = created.headers.get('location');
  const id = location.split('/').at(-1);
  const partialUpdate = await fetch('http://proxy' + location, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ answer: '필수값 누락' }),
  });
  assert.equal(partialUpdate.status, 400, await partialUpdate.clone().text());
  const changed = await fetch('http://proxy' + location, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ category: '접수', question, answer: '수정 답변\n- 상세' }),
  });
  assert.equal(changed.status, 204);
  const latest = await fetch(root + '/ai/faqs?faqEntrySeqs=' + id);
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  const {
    data: [data],
  } = await latest.json();
  assert.equal(data.question, question);
  assert.equal(data.answer, '수정 답변\n- 상세');
  assert.deepEqual(Object.keys(data).sort(), ['answer', 'faqEntrySeq', 'question', 'updatedAt']);
  assert.equal(Object.hasOwn(data, 'updatedByAdminUserSeq'), false);
  const denied = await fetch(root + '/faqs', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ category: '접수', question, answer: '차단' }] }),
  });
  assert.equal(denied.status, 401);
  const list = await fetch(root + '/ai/faqs?' + new URLSearchParams({ q: question }));
  assert.deepEqual(
    (await list.json()).data.map((r) => r.faqEntrySeq),
    [Number(id)],
  );
  const bulk = await fetch(root + '/faqs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      items: [
        { category: '접수', question: question + '-one', answer: '첫 답변' },
        { category: '접수', question: question + '-two', answer: '둘째 답변' },
      ],
    }),
  });
  assert.equal(bulk.status, 204, await bulk.clone().text());
  const all = (
    await (await fetch(root + '/ai/faqs?' + new URLSearchParams({ q: question }))).json()
  ).data;
  assert.equal(all.length, 3);
  const ids = all.map((row) => row.faqEntrySeq);
  const filtered = await fetch(root + '/ai/faqs?faqEntrySeqs=' + ids.join(','));
  const filteredBody = await filtered.json();
  assert.deepEqual(Object.keys(filteredBody).sort(), ['data', 'hasNext', 'total_count']);
  assert.deepEqual(
    filteredBody.data.map((row) => row.faqEntrySeq),
    ids,
  );
  for (const faqEntrySeqs of [[ids[0]], ids.slice(1)]) {
    const deleted = await fetch(root + '/faqs', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ faqEntrySeqs }),
    });
    assert.equal(deleted.status, 204, await deleted.clone().text());
  }
  assert.deepEqual(await (await fetch(root + '/ai/faqs?faqEntrySeqs=' + ids.join(','))).json(), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
});

test('Nginx preserves the admin-only manual order boundary without a service-token bypass', async () => {
  const response = await fetch('http://proxy/api/admin/orders', {
    method: 'POST',
    headers: {
      Origin: 'https://13.209.59.180',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
});

async function draftRuntimeCall(phone) {
  const c = {
    phone,
    providerCallId: 'runtime-draft-' + randomUUID(),
    incomingAt: new Date(Date.now() - 60000).toISOString(),
  };
  const registered = await fetch('http://proxy/api/customers/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...businessHeaders() },
    body: JSON.stringify({
      phoneNumber: phone,
      call: { providerCallId: c.providerCallId, incomingAt: c.incomingAt },
    }),
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  c.id = (await registered.json()).data.callSessionSeq;
  c.headers = {
    'Content-Type': 'application/json',
    ...businessHeaders(),
    call_session_seq: String(c.id),
  };
  return c;
}
async function finishRuntimeCall(c, version) {
  const send = () =>
    fetch('http://proxy/api/calls/' + c.id + '/order-intake/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...businessHeaders() },
      body: JSON.stringify({ expectedIntakeVersion: version }),
    });
  const waiting = await send();
  assert.equal(waiting.status, 200, await waiting.clone().text());
  const receipt = await fetch('http://proxy/api/webhooks/pbx/call-ended', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.TEST_WEBHOOK_TOKEN,
    },
    body: JSON.stringify({
      recordingId: randomUUID(),
      callFrom: c.phone,
      callTo: '07012345678',
      startedAt: c.incomingAt,
      endedAt: new Date(Date.parse(c.incomingAt) + 30000).toISOString(),
      durationSeconds: 30,
      recordingUrl: 'https://recordings.example.invalid/runtime.mp3',
    }),
  });
  assert.equal(receipt.status, 200, await receipt.clone().text());
  const finalized = await send();
  assert.equal(finalized.status, 200, await finalized.clone().text());
  return (await finalized.json()).data;
}
test('Nginx forwards a new AI parcel draft, preserves its call header and replays the fixed UUID', async () => {
  const c = await draftRuntimeCall('01099008877');
  const input = { clientParcelId: randomUUID(), status: 'EDITING', parcel: { smallBoxCount: 1 } };
  const send = () =>
    fetch('http://proxy/api/parcel-drafts', {
      method: 'POST',
      headers: c.headers,
      body: JSON.stringify(input),
    });
  const first = await send();
  assert.equal(first.status, 201, await first.clone().text());
  const saved = (await first.json()).data;
  assert.equal(saved.status, 'EDITING');
  assert.equal(saved.callSessionSeq, c.id);
  assert.equal(saved.orderSeq, null);
  assert.equal((await (await send()).json()).data.draftSeq, saved.draftSeq);
  const result = await finishRuntimeCall(c, saved.intakeVersion);
  assert.equal(result.status, 'NO_ORDER');
  assert.equal(result.orderSeq, null);
});
test('Nginx preserves a new empty AI call with completion replay and no actual order', async () => {
  const c = await draftRuntimeCall('01099008878');
  const result = await finishRuntimeCall(c, 1);
  assert.equal(result.status, 'NO_ORDER');
  assert.equal(result.order, null);
  assert.deepEqual(result.parcelMappings, []);
  const login = await fetch('http://proxy/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://13.209.59.180' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const detail = await fetch('http://proxy/api/calls/' + c.id, {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(detail.status, 200);
  const saved = (await detail.json()).data.call;
  assert.equal(saved.providerCallId, c.providerCallId);
  assert.equal(saved.orderSeq, null);
});
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(process.env.TEST_WEBHOOK_TOKEN);

before(async () => {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch('http://backend:3000/health', {
        signal: AbortSignal.timeout(1000),
      });
      const proxy = await fetch('http://proxy/nginx-health', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && proxy.ok) return;
    } catch {
      /* Backend and Nginx may still be starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Production backend or Nginx did not become live');
});

test('call detail and transcript work through Nginx while the standalone playback route is removed', async () => {
  const anonymous = await fetch('http://proxy/api/calls', { headers: { call_session_seq: '1' } });
  assert.equal(anonymous.status, 401);
  const login = await fetch('http://proxy/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://13.209.59.180' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const response = await fetch('http://proxy/api/calls?limit=1', {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(body.data.length, 1);
  assert.ok(body.data[0].callSessionSeq > 0);
  const detail = await fetch('http://proxy/api/calls/' + body.data[0].callSessionSeq, {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  const { analysis, ...call } = body.data[0];
  assert.deepEqual(detailBody.data.call, call);
  assert.deepEqual(detailBody.data.analysis, analysis);
  assert.ok(Number.isInteger(detailBody.data.aiActionCount));
  assert.ok(detailBody.data.aiActionCount >= 0);
  assert.ok(Array.isArray(detailBody.data.recordings));
  for (const recording of detailBody.data.recordings)
    assert.deepEqual(Object.keys(recording).sort(), [
      'createdAt',
      'expiresAt',
      'playbackError',
      'recordingSeq',
      'url',
    ]);
  assert.ok(detailBody.meta.requestId);
  const transcript = await fetch(
    'http://proxy/api/calls/' + body.data[0].callSessionSeq + '/transcript?limit=1',
    {
      headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
    },
  );
  assert.equal(transcript.status, 200);
  const transcriptBody = await transcript.json();
  assert.deepEqual(Object.keys(transcriptBody).sort(), ['data', 'hasNext', 'total_count']);
  assert.ok(Array.isArray(transcriptBody.data));
  const anonymousPlayback = await fetch('http://proxy/api/recordings/2147483647/url');
  assert.equal(anonymousPlayback.status, 404);
  const missingPlayback = await fetch('http://proxy/api/recordings/2147483647/url', {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(missingPlayback.status, 404);
  assert.equal((await missingPlayback.json()).error.code, 'NOT_FOUND');
});

test('production image keeps health and disables Swagger by default', async () => {
  const health = await fetch('http://backend:3000/health');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'backend' });
  const docs = await fetch('http://backend:3000/api/docs-json');
  assert.equal(docs.status, 404);
  assert.equal((await docs.json()).error.code, 'NOT_FOUND');
});

test('production customer service authentication through Nginx preserves AI and administrator boundaries', async () => {
  const input = {
    name: 'runtime-customer-' + randomUUID(),
    phoneNumber: '010' + String(require('node:crypto').randomInt(10000000, 100000000)),
    address: customerAddress(),
  };
  const headers = { 'Content-Type': 'application/json', ...businessHeaders() };
  for (const authorization of [undefined, 'Bearer wrong-business-token']) {
    const denied = await fetch('http://proxy/api/customers/context', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization === undefined ? {} : { Authorization: authorization }),
      },
      body: JSON.stringify({ phoneNumber: input.phoneNumber }),
    });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).error.code, 'UNAUTHORIZED');
  }
  const register = () =>
    fetch('http://proxy/api/customers', { method: 'POST', headers, body: JSON.stringify(input) });
  const first = await register();
  assert.equal(first.status, 201);
  const id = (await first.json()).data.customerSeq;
  const initial = await fetch('http://proxy/api/customers/context', {
    method: 'POST',
    headers,
    body: JSON.stringify({ phoneNumber: input.phoneNumber }),
  });
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  const initialBody = await initial.json();
  assert.equal(initialBody.data.lookupStatus, 'REGISTERED');
  assert.equal(initialBody.data.customer.customerSeq, id);
  assert.deepEqual(initialBody.data.availableUsageTypes, ['PERSONAL']);
  assert.deepEqual(initialBody.data.personalPins, []);
  assert.deepEqual(initialBody.data.companyPins, []);
  assert.ok(initialBody.meta.requestId);
  const replay = await register();
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, 'DUPLICATE_RESOURCE');
  const detail = await fetch('http://proxy/api/customers/' + id, { headers });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.phoneNumber, input.phoneNumber);
  const rename = await fetch('http://proxy/api/customers/' + id, {
    method: 'PATCH',
    headers,
    body: '{"name":"runtime renamed customer"}',
  });
  assert.equal(rename.status, 204);
  assert.equal(await rename.text(), '');
  assert.equal((await fetch('http://proxy/api/customers')).status, 401);
  const aiStatus = await fetch('http://proxy/api/customers/' + id, {
    method: 'PATCH',
    headers: { ...headers, Origin: 'https://13.209.59.180' },
    body: '{"status":"WITHDRAWN"}',
  });
  assert.equal(aiStatus.status, 403);
  const login = await fetch('http://proxy/api/auth/login', {
    method: 'POST',
    headers: { ...headers, Origin: 'https://13.209.59.180' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const adminHeaders = {
    ...headers,
    Cookie: login.headers.get('set-cookie').split(';')[0],
    Origin: 'https://13.209.59.180',
  };
  const withdrawn = await fetch('http://proxy/api/customers/' + id, {
    method: 'PATCH',
    headers: adminHeaders,
    body: '{"status":"WITHDRAWN"}',
  });
  assert.equal(withdrawn.status, 204);
  assert.equal((await fetch('http://proxy/api/customers/' + id, { headers })).status, 404);
  const adminDetail = await fetch('http://proxy/api/customers/' + id, { headers: adminHeaders });
  assert.equal(adminDetail.status, 200);
  assert.equal((await adminDetail.json()).data.status, 'WITHDRAWN');
});

test('production company endpoints require a real session for every operation', async () => {
  for (const [method, path] of [
    ['GET', '/api/companies'],
    ['POST', '/api/companies'],
    ['GET', '/api/companies/1'],
    ['PATCH', '/api/companies/1'],
  ]) {
    const response = await fetch('http://proxy' + path, {
      method,
      headers: { Origin: 'https://13.209.59.180' },
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  }
});

test('production member JSON supports single and bulk registration through Nginx and preserves session/CRUD boundaries', async () => {
  const root = 'http://proxy/api';
  const origin = 'https://13.209.59.180';
  const json = { 'Content-Type': 'application/json', Origin: origin };
  const login = await fetch(root + '/auth/login', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const session = login.headers.get('set-cookie').split(';')[0];
  const headers = { ...json, Cookie: session };
  const company = await fetch(root + '/companies', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'runtime-members-' + randomUUID() }),
  });
  assert.equal(company.status, 201);
  const companyId = (await company.json()).data.organizationSeq;
  const department = await fetch(root + `/companies/${companyId}/departments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '운영 이미지 검증팀' }),
  });
  assert.equal(department.status, 201);
  const departmentId = (await department.json()).data.departmentSeq;
  const number = '019' + String(require('node:crypto').randomInt(10000000, 100000000));
  const register = async (items, authenticated = true) =>
    fetch(root + `/companies/${companyId}/members`, {
      method: 'POST',
      headers: { ...json, ...(authenticated ? { Cookie: session } : {}) },
      body: JSON.stringify({ items }),
    });
  const content = [
    {
      employeeNo: '001',
      name: '운영 이미지 고객',
      phoneNumber: number,
      departmentSeq: departmentId,
    },
  ];
  assert.equal((await register(content, false)).status, 401);
  assert.equal((await register(content)).status, 204);
  assert.equal((await register(content)).status, 204);
  assert.equal(
    (await fetch(root + `/companies/${companyId}/members/import`, { method: 'POST', headers }))
      .status,
    404,
  );
  const tooLarge = await register([{ ...content[0], name: 'x'.repeat(1024 * 1024) }]);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, 'PAYLOAD_TOO_LARGE');
  const list = await fetch(root + `/companies/${companyId}/members`, {
    headers: { Cookie: session },
  });
  assert.equal(list.status, 200);
  const row = (await list.json()).data[0];
  const customerId = row.customer.customerSeq,
    membershipId = row.membership.membershipSeq;
  const nextPhone = '018' + String(require('node:crypto').randomInt(10000000, 100000000));
  assert.equal(
    (
      await register([
        {
          employeeNo: '001',
          name: '운영 이미지 고객',
          phoneNumber: nextPhone,
          departmentSeq: departmentId,
        },
      ])
    ).status,
    204,
  );
  const customer = await fetch(root + '/customers/' + customerId, { headers });
  assert.equal(customer.status, 200);
  assert.equal((await customer.json()).data.phoneNumber, nextPhone);
  const patch = await fetch(root + '/members/' + membershipId, {
    method: 'PATCH',
    headers,
    body: '{"role":"ORG_ADMIN","status":"INACTIVE"}',
  });
  assert.equal(patch.status, 204);
  const removed = await fetch(root + '/members/' + membershipId, { method: 'DELETE', headers });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(root + '/customers/' + customerId, { headers })).status, 200);
  const empty = await fetch(root + `/companies/${companyId}/members`, {
    headers: { Cookie: session },
  });
  assert.deepEqual(await empty.json(), { data: [], hasNext: false, total_count: 0 });
});

test('real Nginx preserves /api, strips the legacy prefix and hides readiness', async () => {
  const requestId = randomUUID();
  const response = await fetch('http://proxy/api/not-implemented', {
    headers: { 'X-Request-Id': requestId },
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(body.meta.requestId, requestId);
  assert.equal(response.headers.get('x-request-id'), requestId);
  const health = await fetch('http://proxy/api/health');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'backend' });
  const readiness = await fetch('http://proxy/api/health/ready');
  assert.equal(readiness.status, 404);
  assert.ok(!(await readiness.text()).includes('dependencies'));
});

test('production image receives the existing PBX contract through real Nginx with the configured frontend origin', async () => {
  const recordingId = 'runtime-' + randomUUID();
  const response = await fetch('http://proxy/api/webhooks/pbx/call-ended', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + process.env.TEST_WEBHOOK_TOKEN,
      Origin: 'https://13.209.59.180',
    },
    body: JSON.stringify({
      recordingId,
      callFrom: '01000000000',
      callTo: '07000000000',
      startedAt: '2026-10-23T00:00:00Z',
      endedAt: '2026-10-23T00:03:00Z',
      durationSeconds: 180,
      recordingUrl: 'https://example.invalid/test.mp3',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://13.209.59.180');
  assert.deepEqual(await response.json(), { status: 'received', recordingId, duplicate: false });
});

test('production login through Nginx authorizes company operations and logout revokes access', async () => {
  const headers = {
    'Content-Type': 'application/json',
    Origin: 'https://13.209.59.180',
  };
  const login = await fetch('http://proxy/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api'])
    assert.ok(cookie.includes(flag));
  const session = cookie.split(';')[0];
  const me = await fetch('http://proxy/api/auth/me', { headers: { Cookie: session } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.loginId, 'runtimeAdmin83');
  const name = 'runtime-company-' + randomUUID();
  const companyHeaders = { ...headers, Cookie: session };
  const register = () =>
    fetch('http://proxy/api/companies', {
      method: 'POST',
      headers: companyHeaders,
      body: JSON.stringify({ name }),
    });
  const created = await register();
  assert.equal(created.status, 201);
  const id = (await created.json()).data.organizationSeq;
  const list = await fetch('http://proxy/api/companies?q=' + encodeURIComponent(name), {
    headers: { Cookie: session },
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).data[0].organizationSeq, id);
  const detail = await fetch('http://proxy/api/companies/' + id, { headers: { Cookie: session } });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.name, name);
  const missingOrigin = await fetch('http://proxy/api/companies/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: '{"status":"INACTIVE"}',
  });
  assert.equal(missingOrigin.status, 403);
  const updated = await fetch('http://proxy/api/companies/' + id, {
    method: 'PATCH',
    headers: companyHeaders,
    body: '{"status":"INACTIVE"}',
  });
  assert.equal(updated.status, 204);
  assert.equal(await updated.text(), '');
  const inactive = await fetch('http://proxy/api/companies/' + id, {
    headers: { Cookie: session },
  });
  assert.equal((await inactive.json()).data.status, 'INACTIVE');
  const orderBody = { customer: { name: '주문 검증', phoneNumber: '01000880088' }, parcels: [] };
  const order = () =>
    fetch('http://proxy/api/orders', {
      method: 'POST',
      headers: { ...companyHeaders, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(orderBody),
    });
  const registered = await order();
  assert.equal(registered.status, 201);
  assert.ok((await registered.json()).data.orderSeq > 0);
  const logout = await fetch('http://proxy/api/auth/logout', {
    method: 'POST',
    headers: { ...headers, Cookie: session },
  });
  assert.equal(logout.status, 204);
  assert.equal(
    (await fetch('http://proxy/api/auth/me', { headers: { Cookie: session } })).status,
    401,
  );
  assert.equal(
    (await fetch('http://proxy/api/companies', { headers: { Cookie: session } })).status,
    401,
  );
});

test('production personal PIN APIs accept stale versions and company PIN routes are retired through Nginx', async () => {
  const root = 'http://proxy/api';
  const headers = { 'Content-Type': 'application/json', Origin: 'https://13.209.59.180' };
  const login = await fetch(root + '/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const admin = { ...headers, Cookie: login.headers.get('set-cookie').split(';')[0] };
  const number = '010' + String(require('node:crypto').randomInt(10000000, 100000000));
  const customer = await fetch(root + '/customers', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({
      address: customerAddress(),
      name: '주소록 운영 검증',
      phoneNumber: number,
    }),
  });
  assert.equal(customer.status, 201);
  const customerId = (await customer.json()).data.customerSeq;
  const addressData = {
    name: '검증 수령인',
    phoneNumber: number,
    roadAddress: '예시로 1',
    jibunAddress: '예시동 1',
    detailAddress: '101호',
    dongName: '예시동',
    postalCode: '01234',
  };
  const created = await fetch(root + `/customers/${customerId}/pins`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ addressData }),
  });
  assert.equal(created.status, 201);
  const pin = (await created.json()).data.personalPinSeq;
  for (const label of ['먼저 수정', '나중 수정']) {
    const updated = await fetch(root + `/pins/${pin}`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ label, expectedVersion: 1 }),
    });
    assert.equal(updated.status, 200);
  }
  const listed = await fetch(root + `/customers/${customerId}/pins`, { headers: admin });
  const stored = (await listed.json()).data[0];
  assert.equal(stored.label, '나중 수정');
  assert.equal(stored.version, 3);
  assert.equal(stored.addressData.detailAddress, '101호');
  const company = await fetch(root + '/companies', {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ name: '주소록 기업 ' + randomUUID() }),
  });
  assert.equal(company.status, 201);
  const companyId = (await company.json()).data.organizationSeq;
  for (const [method, path, body] of [
    ['GET', '/companies/' + companyId + '/pins'],
    ['POST', '/companies/' + companyId + '/pins', { addressData }],
    ['PATCH', '/company-pins/1', { label: '금지' }],
  ]) {
    const retired = await fetch(root + path, {
      method,
      headers: admin,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(retired.status, 404);
  }
  for (const [method, path, body] of [
    ['GET', `/customers/${customerId}/pins`, undefined],
    ['POST', `/customers/${customerId}/pins`, { addressData }],
  ]) {
    const unknown = await fetch(root + path, {
      method,
      headers: { ...headers, call_session_seq: '2147483647' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(unknown.status, 404);
  }
});

test('production order address history reads stored snapshots through Nginx and keeps customer scope', async () => {
  const root = 'http://proxy/api';
  const login = await fetch(root + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://13.209.59.180' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  const orders = await fetch(root + '/orders?status=ACCEPTED&limit=1', { headers });
  const order = (await orders.json()).data[0];
  assert.ok(order?.customerSeq);
  const history = await fetch(
    root + `/customers/${order.customerSeq}/addresses?direction=DESTINATION&limit=1`,
    { headers },
  );
  assert.equal(history.status, 200);
  assert.equal(history.headers.get('cache-control'), 'no-store');
  const body = await history.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(body.data[0].orderSeq, order.orderSeq);
  const detail = await fetch(root + '/orders/' + order.orderSeq, { headers });
  const parcel = (await detail.json()).data.parcels.find(
    (p) => p.orderParcelSeq === body.data[0].orderParcelSeq,
  );
  assert.deepEqual(body.data[0].address, parcel.destination);
  const missing = await fetch(
    root + `/customers/${order.customerSeq}/addresses?direction=DESTINATION`,
  );
  assert.equal(missing.status, 400);
  const unknown = await fetch(
    root + `/customers/${order.customerSeq}/addresses?direction=DESTINATION`,
    {
      headers: { call_session_seq: '2147483647' },
    },
  );
  assert.equal(unknown.status, 404);
  const invalid = await fetch(root + `/customers/${order.customerSeq}/addresses?direction=BOTH`, {
    headers,
  });
  assert.equal(invalid.status, 400);
});

test('production company directory searches current member addresses through Nginx without opening management APIs', async () => {
  const root = 'http://proxy/api';
  const login = await fetch(root + '/auth/login', {
    method: 'POST',
    headers: { Origin: 'https://13.209.59.180', 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const headers = {
    Cookie: login.headers.get('set-cookie').split(';')[0],
    Origin: 'https://13.209.59.180',
    'Content-Type': 'application/json',
  };
  const name = '공식배송지-' + randomUUID();
  const registered = await fetch(root + '/companies', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name }),
  });
  assert.equal(registered.status, 201);
  const id = (await registered.json()).data.organizationSeq;
  const addressData = {
    name: '공식 담당자',
    phoneNumber: '010' + String(require('node:crypto').randomInt(10000000, 100000000)),
    roadAddress: '공식로 1',
    jibunAddress: '공식동 1',
    detailAddress: '',
    dongName: '공식동',
    postalCode: '01234',
  };
  const { name: recipientName, phoneNumber, ...address } = addressData;
  const created = await fetch(root + '/companies/' + id + '/members', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      items: [{ employeeNo: 'RUNTIME-DIR', name: recipientName, phoneNumber, address }],
    }),
  });
  assert.equal(created.status, 204, await created.text());
  const url = root + '/companies/search?' + new URLSearchParams({ q: name + ' ' + recipientName });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers })).status, 401);
  const searched = await fetch(url, { headers: businessHeaders() });
  assert.equal(searched.status, 200);
  assert.equal(searched.headers.get('cache-control'), 'no-store');
  const body = await searched.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(body.data[0].organizationSeq, id);
  assert.ok(body.data[0].customerSeq);
  assert.equal(body.data[0].companyPinSeq, undefined);
  assert.equal(body.data[0].organizationName, name);
  assert.deepEqual(body.data[0].addressData, addressData);
  const adminSearchUrl = root + '/companies/members/search?q=RUNTIME-DIR';
  assert.equal((await fetch(adminSearchUrl, { headers: businessHeaders() })).status, 401);
  const memberSearch = await fetch(adminSearchUrl, { headers });
  assert.equal(memberSearch.status, 200);
  const members = await memberSearch.json();
  assert.equal(members.data[0].organizationSeq, id);
  assert.equal(members.data[0].name, recipientName);
  assert.equal(members.data[0].phoneNumber, phoneNumber);
  assert.equal(members.data[0].employeeNo, 'RUNTIME-DIR');
  assert.equal(members.data[0].organizationStatus, 'ACTIVE');
  assert.equal((await fetch(root + '/companies')).status, 401);
  assert.equal((await fetch(root + `/companies/${id}/members`)).status, 401);
  const deactivated = await fetch(root + `/companies/${id}`, {
    method: 'PATCH',
    headers,
    body: '{"status":"INACTIVE"}',
  });
  assert.equal(deactivated.status, 204);
  assert.deepEqual(await (await fetch(url, { headers: businessHeaders() })).json(), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
  assert.deepEqual(await (await fetch(adminSearchUrl, { headers })).json(), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
  const inactiveMembers = await (
    await fetch(adminSearchUrl + '&includeInactive=true', { headers })
  ).json();
  assert.equal(inactiveMembers.data[0].organizationStatus, 'INACTIVE');
  assert.equal(
    (await fetch(root + '/companies/search?q=', { headers: businessHeaders() })).status,
    400,
  );
});

test('production draft cancellation preserves AI call scope and administrator sessions through Nginx', async () => {
  const c = await draftRuntimeCall('01064000641');
  const create = async (call) => {
    const response = await fetch('http://proxy/api/parcel-drafts', {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify({
        clientParcelId: randomUUID(),
        status: 'EDITING',
        parcel: { smallBoxCount: 1 },
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).data;
  };
  const own = await create(c);
  const other = await create(await draftRuntimeCall('01064000642'));
  const patch = (id) =>
    fetch('http://proxy/api/parcel-drafts/' + id, {
      method: 'PATCH',
      headers: c.headers,
      body: JSON.stringify({ expectedVersion: 1, action: 'CANCEL' }),
    });
  assert.equal((await patch(other.draftSeq)).status, 404);
  const response = await patch(own.draftSeq);
  assert.equal(response.status, 200);
  const cancelled = (await response.json()).data;
  assert.equal(cancelled.status, 'CANCELLED');
  const login = await fetch('http://proxy/api/auth/login', {
    method: 'POST',
    headers: { Origin: 'https://13.209.59.180', 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const admin = {
    Origin: 'https://13.209.59.180',
    Cookie: login.headers.get('set-cookie').split(';')[0],
    'Content-Type': 'application/json',
  };
  assert.equal(
    (
      await fetch('http://proxy/api/parcel-drafts/' + own.draftSeq, {
        method: 'DELETE',
        headers: admin,
      })
    ).status,
    204,
  );
  const order = await fetch('http://proxy/api/orders', {
    method: 'POST',
    headers: { ...admin, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({
      customer: { name: '관리자 취소 검증', phoneNumber: '01064000999' },
      parcels: [],
    }),
  });
  assert.equal(order.status, 201, await order.clone().text());
  const id = (await order.json()).data.orderSeq;
  assert.equal(
    (await fetch('http://proxy/api/orders/' + id + '/cancel', { method: 'POST', headers: admin }))
      .status,
    204,
  );
  await finishRuntimeCall(c, cancelled.intakeVersion);
});

test('Nginx forwards the call_session_seq header without losing its underscores', async () => {
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() };
  const body = JSON.stringify({ customer: { name: '주문 검증', phoneNumber: '01000880088' } });
  const missing = await fetch('http://proxy/api/orders', { method: 'POST', headers, body });
  assert.equal(missing.status, 400);
  const unknown = await fetch('http://proxy/api/orders', {
    method: 'POST',
    headers: { ...headers, call_session_seq: '2147483647' },
    body,
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'NOT_FOUND');
  for (const [method, path, payload] of [
    ['GET', '/api/orders', undefined],
    ['GET', '/api/orders/2147483647', undefined],
    ['POST', '/api/orders/2147483647/submit', JSON.stringify({ expectedVersion: 1 })],
    ['POST', '/api/orders/2147483647/cancel', undefined],
    [
      'POST',
      '/api/orders/2147483647/parcels/cancel',
      JSON.stringify({ orderParcelSeqs: [2147483647] }),
    ],
    [
      'PATCH',
      '/api/orders/2147483647',
      JSON.stringify({ expectedVersion: 1, paymentMethodType: 'billing' }),
    ],
  ]) {
    const response = await fetch('http://proxy' + path, {
      method,
      headers: { ...headers, call_session_seq: '2147483647' },
      body: payload,
    });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
  const preflight = await fetch('http://proxy/api/orders', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://13.209.59.180',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,idempotency-key,call_session_seq',
    },
  });
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('access-control-allow-headers').includes('call_session_seq'));
});

test('production active count SSE crosses HTTPS and both Nginx proxies, keeps heartbeats and closes after logout', async () => {
  const root = process.env.TEST_HTTPS_API_ROOT;
  assert.match(root, /^https:\/\//);
  const origin = 'https://13.209.59.180';
  const login = await fetch(root + '/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId: 'runtimeAdmin83', password: 'runtime-only-password' }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin };
  const controller = new AbortController();
  const response = await fetch(root + '/calls/active-count/stream', {
    headers,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(type) {
    for (;;) {
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.split('\n').some((line) => line === 'event: ' + type))
          return JSON.parse(
            frame
              .split('\n')
              .find((line) => line.startsWith('data:'))
              .slice(5),
          );
        boundary = buffer.indexOf('\n\n');
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'SSE closed before ' + type);
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
    }
  }
  try {
    const initial = await next('active-call-count');
    assert.deepEqual(Object.keys(initial).sort(), ['activeCallCount', 'observedAt']);
    const startedAt = new Date(Date.now() - 20000).toISOString();
    const phone = '010' + require('node:crypto').randomInt(10000000, 100000000);
    const registered = await fetch(root + '/customers/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...businessHeaders() },
      body: JSON.stringify({
        phoneNumber: phone,
        call: { providerCallId: randomUUID(), incomingAt: startedAt },
      }),
    });
    assert.equal(registered.status, 200);
    assert.equal((await next('active-call-count')).activeCallCount, initial.activeCallCount + 1);
    await next('heartbeat');
    await next('heartbeat');
    const ended = await fetch(root + '/webhooks/pbx/call-ended', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.TEST_WEBHOOK_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recordingId: 'runtime-count-' + randomUUID(),
        callFrom: phone,
        callTo: '07012345678',
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + 10000).toISOString(),
        durationSeconds: 10,
        recordingUrl: 'https://recordings.example.test/audio.mp3',
      }),
    });
    assert.equal(ended.status, 200);
    assert.equal((await next('active-call-count')).activeCallCount, initial.activeCallCount);
    const snapshot = await fetch(root + '/calls/active-count', { headers });
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).data.activeCallCount, initial.activeCallCount);
    const logout = await fetch(root + '/auth/logout', { method: 'POST', headers });
    assert.equal(logout.status, 204);
    assert.deepEqual(await next('session-expired'), { code: 'UNAUTHORIZED' });
    assert.equal((await fetch(root + '/calls/active-count', { headers })).status, 401);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test('HTTPS proxy preserves administrator authentication, internal blocking and PBX POST-only routing', async () => {
  const root = process.env.TEST_HTTPS_API_ROOT;
  assert.match(root, /^https:\/\//);
  for (const [path, status] of [
    ['/calls/active-count', 401],
    ['/calls/active-count/stream', 401],
    ['/internal/metrics', 404],
    ['/health/ready', 404],
    ['/health/ready/', 404],
    ['/webhooks/pbx/call-ended', 405],
  ]) {
    const response = await fetch(root + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, status, path);
  }
});

test('HTTPS and development login IP buckets reject bursts with the established JSON/CORS contract', async () => {
  // Let any earlier HTTPS login leave the six-request burst allowance fully available.
  await delay(12_000);
  for (const root of [process.env.TEST_HTTPS_API_ROOT, 'http://development-proxy/api']) {
    const send = (index) =>
      fetch(root + (index % 2 ? '/AUTH/LOGIN/' : '/auth/login'), {
        method: 'POST',
        headers: {
          Origin: 'https://13.209.59.180',
          'Content-Type': 'application/json',
          'X-Forwarded-For': '192.0.2.' + index,
          'X-Real-IP': '198.51.100.' + index,
        },
        body: JSON.stringify({ loginId: 'invalid-login-id', password: 'x' }),
      });
    for (let index = 0; index < 6; index++) {
      const accepted = await send(index);
      assert.equal(accepted.status, 400, await accepted.text());
    }
    const rejected = await send(7);
    assert.equal(rejected.status, 429, await rejected.clone().text());
    assert.equal(rejected.headers.get('retry-after'), '2');
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.equal(rejected.headers.get('access-control-allow-origin'), 'https://13.209.59.180');
    assert.ok(
      rejected.headers.get('access-control-expose-headers').toLowerCase().includes('retry-after'),
    );
    const body = await rejected.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.deepEqual(body.error.details, []);
    assert.equal(rejected.headers.get('x-request-id'), body.meta.requestId);
    const preflight = await fetch(root + '/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: 'https://13.209.59.180', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal((await fetch(root + '/ai/faqs')).status, 200);
  }
});

test('signup limits survive HTTPS proxy forwarding and development proxy header sanitization', async () => {
  for (const root of [process.env.TEST_HTTPS_API_ROOT, 'http://development-proxy/api']) {
    const send = (index) =>
      fetch(root + '/auth/signup', {
        method: 'POST',
        headers: {
          Origin: 'https://13.209.59.180',
          'Content-Type': 'application/json',
          'X-Forwarded-For': `192.0.2.${index}, 198.51.100.${index}`,
          'X-Real-IP': '203.0.113.' + index,
        },
        body: JSON.stringify({
          loginId: 'runtimeLimit01',
          password: 'test-only-password',
          name: '',
        }),
      });
    for (let index = 0; index < 5; index++) {
      const accepted = await send(index);
      assert.equal(accepted.status, 400, await accepted.text());
    }
    const rejected = await send(9);
    assert.equal(rejected.status, 429);
    assert.ok(Number(rejected.headers.get('retry-after')) > 0);
    assert.ok(Number(rejected.headers.get('retry-after')) <= 600);
    assert.equal((await rejected.json()).error.code, 'RATE_LIMITED');
  }
});
