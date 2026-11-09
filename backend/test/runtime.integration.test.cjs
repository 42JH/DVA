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
  assert.equal(saved.analysisStatus, 'PENDING');
  assert.equal(saved.recordedAt, null);
  assert.equal(saved.customerSeq, null);
  assert.equal(saved.organizationName, null);
  assert.notEqual(process.env.TEST_INSIGHTS_TOKEN, process.env.TEST_BUSINESS_TOKEN);
  const analysisUrl = 'http://proxy/api/ai/calls/' + c.id + '/analysis';
  const sendFailure = (authorization) =>
    fetch(analysisUrl + '/failure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ providerCallId: c.providerCallId }),
    });
  assert.equal((await sendFailure('Bearer ' + process.env.TEST_BUSINESS_TOKEN)).status, 401);
  const authorization = 'Bearer ' + process.env.TEST_INSIGHTS_TOKEN;
  assert.equal((await sendFailure(authorization)).status, 204);
  assert.equal((await sendFailure(authorization)).status, 204);
  const list = await fetch('http://proxy/api/calls?callerPhoneNumber=' + c.phone, {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(list.status, 200);
  const failed = (await list.json()).data.find((row) => row.callSessionSeq === c.id);
  assert.equal(failed.analysisStatus, 'FAILED');
  assert.equal(failed.recordedAt, null);
  assert.equal(failed.organizationName, null);
  const recovered = await fetch(analysisUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({
      providerCallId: c.providerCallId,
      startedAt: c.incomingAt,
      endedAt: new Date(Date.parse(c.incomingAt) + 30000).toISOString(),
      aiPersonaVersionSeq: null,
      repeatQuestionCount: null,
      hasComplaint: null,
      complaints: [],
    }),
  });
  assert.equal(recovered.status, 204, await recovered.clone().text());
  assert.equal((await sendFailure(authorization)).status, 204);
  const after = await fetch('http://proxy/api/calls/' + c.id, {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(after.status, 200);
  const completed = (await after.json()).data;
  assert.equal(completed.call.analysisStatus, 'COMPLETED');
  assert.equal(completed.call.orderSeq, null);
  assert.ok(completed.analysis);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const path of ['/api/calls', '/api/admin/orders']) {
    const filtered = await fetch('http://proxy' + path + '?organizationSeq=2147483647', {
      headers: { Cookie: cookie },
    });
    assert.equal(filtered.status, 200);
    assert.deepEqual(await filtered.json(), {
      data: [],
      hasNext: false,
      total_count: 0,
      ...(path === '/api/admin/orders'
        ? {
            statusCounts: {
              all: 0,
              incomplete: 0,
              notPaid: 0,
              paid: 0,
              submissionFailed: 0,
              cancelled: 0,
            },
          }
        : {}),
    });
  }
  const orders = await fetch('http://proxy/api/admin/orders?limit=1', {
    headers: { Cookie: cookie },
  });
  assert.equal(orders.status, 200);
  const rows = (await orders.json()).data;
  assert.equal(rows.length, 1);
  for (const field of ['customerSeq', 'organizationName']) assert.ok(Object.hasOwn(rows[0], field));
  assert.equal(Object.hasOwn(rows[0], 'customerCategory'), false);
  const home = await fetch('http://proxy/api/dashboard/home', { headers: { Cookie: cookie } });
  assert.equal(home.status, 200, await home.clone().text());
  assert.equal(home.headers.get('cache-control'), 'no-store');
  const summary = (await home.json()).data;
  assert.ok(summary.pendingWork.incomplete >= 0);
  for (const field of ['todayOrderCount', 'todayCallCount'])
    assert.ok(Number.isInteger(summary[field]) && summary[field] >= 0);
  for (const field of ['recentCalls', 'incompleteDrafts', 'unansweredQuestions'])
    assert.ok(Array.isArray(summary[field]) && summary[field].length <= 11);
  assert.ok(summary.aiPerformance.stageDropoffs);
  const headers = {
    Cookie: cookie,
    Origin: 'https://13.209.59.180',
    'Content-Type': 'application/json',
  };
  const ids = [];
  for (let index = 0; index < 2; index++) {
    const created = await fetch('http://proxy/api/companies', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'runtime-qa-' + randomUUID() }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    ids.push((await created.json()).data.organizationSeq);
  }
  const deleted = await fetch('http://proxy/api/companies', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ organizationSeqs: ids }),
  });
  assert.equal(deleted.status, 204, await deleted.clone().text());
  assert.equal(await deleted.text(), '');
  for (const id of ids)
    assert.equal((await fetch('http://proxy/api/companies/' + id, { headers })).status, 404);
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
  const list = await fetch('http://proxy/api/customers?phoneNumber=' + input.phoneNumber, {
    headers: adminHeaders,
  });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const listBody = await list.json();
  assert.equal(listBody.total_count, 1);
  assert.equal(listBody.data[0].customerSeq, id);
  assert.deepEqual(listBody.data[0].availablePaymentMethods, ['billing']);
  assert.deepEqual(
    listBody.data[0].availablePaymentMethods,
    initialBody.data.availablePaymentMethods,
  );
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
  const deniedAdminSearch = await fetch('http://proxy/api/admins?q=runtime&status=ACTIVE', {
    headers: { Cookie: session },
  });
  assert.equal(deniedAdminSearch.status, 403);
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
