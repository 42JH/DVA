const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('Nginx forwards an AI consultation result in the JSON body without a call header', async () => {
  const key = randomUUID();
  const input = {
    outcome: 'INCOMPLETE',
    call: {
      providerCallId: `runtime-${key}`,
      callerPhoneNumber: '01099008877',
      incomingAt: '2026-10-27T01:00:00Z',
    },
  };
  const send = () =>
    fetch('http://proxy/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    });
  const response = await send();
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(data.status, 'COLLECTING');
  assert.ok(data.callSessionSeq > 0);
  assert.deepEqual((await (await send()).json()).data, data);
});
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(process.env.TEST_WEBHOOK_TOKEN);

before(async () => {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch('http://backend:3000/health', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
    } catch {
      /* Production container may still be initializing its database connection. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Production image did not become live');
});

test('call list and detail through Nginx require a session and preserve response contracts', async () => {
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
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
  assert.equal(body.data.length, 1);
  assert.ok(body.data[0].callSessionSeq > 0);
  const detail = await fetch('http://proxy/api/calls/' + body.data[0].callSessionSeq, {
    headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.deepEqual(detailBody.data.call, body.data[0]);
  assert.ok(Array.isArray(detailBody.data.recordings));
  assert.ok(detailBody.meta.requestId);
  const transcript = await fetch(
    'http://proxy/api/calls/' + body.data[0].callSessionSeq + '/transcript?limit=1',
    {
      headers: { Cookie: login.headers.get('set-cookie').split(';')[0] },
    },
  );
  assert.equal(transcript.status, 200);
  const transcriptBody = await transcript.json();
  assert.deepEqual(Object.keys(transcriptBody).sort(), ['data', 'hasNext']);
  assert.ok(Array.isArray(transcriptBody.data));
});

test('production image keeps health and disables Swagger by default', async () => {
  const health = await fetch('http://backend:3000/health');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'backend' });
  const docs = await fetch('http://backend:3000/api/docs-json');
  assert.equal(docs.status, 404);
  assert.equal((await docs.json()).error.code, 'NOT_FOUND');
});

test('production customer MVP flow through Nginx needs no service token while admin operations remain protected', async () => {
  const input = {
    name: 'runtime-customer-' + randomUUID(),
    phoneNumber: '010' + String(require('node:crypto').randomInt(10000000, 100000000)),
  };
  const key = randomUUID();
  const headers = { 'Content-Type': 'application/json' };
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
  const detail = await fetch('http://proxy/api/customers/' + id);
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
  const anonymousStatus = await fetch('http://proxy/api/customers/' + id, {
    method: 'PATCH',
    headers: { ...headers, Origin: 'https://13.209.59.180' },
    body: '{"status":"WITHDRAWN"}',
  });
  assert.equal(anonymousStatus.status, 401);
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
  assert.equal((await fetch('http://proxy/api/customers/' + id)).status, 404);
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

test('production member CSV supports a full 1MiB file through Nginx and preserves session/CRUD boundaries', async () => {
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
  const number = '019' + String(require('node:crypto').randomInt(10000000, 100000000));
  const prefix = 'employeeNo,name,phoneNumber\n001,';
  const suffix = ',' + number;
  const content = prefix + 'a'.repeat(1024 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix;
  assert.equal(Buffer.byteLength(content), 1024 * 1024);
  const upload = async (data, authenticated = true) => {
    const form = new FormData();
    form.append('file', new Blob([data], { type: 'text/csv' }), 'members.csv');
    return fetch(root + `/companies/${companyId}/members/import`, {
      method: 'POST',
      headers: {
        Origin: origin,
        ...(authenticated ? { Cookie: session } : {}),
      },
      body: form,
    });
  };
  assert.equal((await upload(content, false)).status, 401);
  assert.equal((await upload(content)).status, 204);
  assert.equal((await upload(content)).status, 204);
  const tooLarge = await upload(content + 'a');
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
    (await upload(`employeeNo,name,phoneNumber\n001,운영 이미지 고객,${nextPhone}`)).status,
    204,
  );
  const customer = await fetch(root + '/customers/' + customerId);
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
  assert.equal((await fetch(root + '/customers/' + customerId)).status, 200);
  const empty = await fetch(root + `/companies/${companyId}/members`, {
    headers: { Cookie: session },
  });
  assert.deepEqual(await empty.json(), { data: [], hasNext: false });
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
  const key = randomUUID();
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

test('production pin APIs preserve admin-only company writes and accept stale versions through Nginx', async () => {
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
    body: JSON.stringify({ name: '주소록 운영 검증', phoneNumber: number }),
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
    latitude: 37.5,
    longitude: 127,
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
  const shared = await fetch(root + `/companies/${companyId}/pins`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ addressData }),
  });
  assert.equal(shared.status, 201);
  const sharedId = (await shared.json()).data.companyPinSeq;
  for (const [method, path, body] of [
    ['POST', `/companies/${companyId}/pins`, { addressData }],
    ['PATCH', `/company-pins/${sharedId}`, { label: '금지' }],
  ]) {
    const denied = await fetch(root + path, { method, headers, body: JSON.stringify(body) });
    assert.equal(denied.status, 401);
  }
  for (const [method, path, body] of [
    ['GET', `/customers/${customerId}/pins`, undefined],
    ['GET', `/companies/${companyId}/pins`, undefined],
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
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
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

test('production company directory searches official PINs through Nginx without opening management APIs', async () => {
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
    phoneNumber: '07012345678',
    roadAddress: '공식로 1',
    jibunAddress: '공식동 1',
    detailAddress: '',
    dongName: '공식동',
    postalCode: '01234',
    latitude: 37.5,
    longitude: 127,
  };
  const created = await fetch(root + `/companies/${id}/pins`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label: '물류센터', departmentName: '운영부', addressData }),
  });
  assert.equal(created.status, 201);
  const pinId = (await created.json()).data.companyPinSeq;
  const url = root + '/companies/search?' + new URLSearchParams({ q: name + ' 운영부' });
  const searched = await fetch(url);
  assert.equal(searched.status, 200);
  assert.equal(searched.headers.get('cache-control'), 'no-store');
  const body = await searched.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
  assert.equal(body.data[0].organizationSeq, id);
  assert.equal(body.data[0].companyPinSeq, pinId);
  assert.equal(body.data[0].organizationName, name);
  assert.deepEqual(body.data[0].addressData, addressData);
  assert.equal((await fetch(root + '/companies')).status, 401);
  assert.equal((await fetch(root + `/companies/${id}/members`)).status, 401);
  const deactivated = await fetch(root + `/companies/${id}`, {
    method: 'PATCH',
    headers,
    body: '{"status":"INACTIVE"}',
  });
  assert.equal(deactivated.status, 204);
  assert.deepEqual(await (await fetch(url)).json(), { data: [], hasNext: false });
  assert.equal((await fetch(root + '/companies/search?q=')).status, 400);
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
