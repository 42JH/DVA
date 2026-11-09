const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const customerAddress = require('./helpers/customer-address.cjs');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const { AuditService } = require('../dist/audit/audit.service');
const f = applicationFixture('기업 일괄 삭제 QA');
async function created(path, body) {
  const response = await f.write('POST', path, body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).data;
}
async function company() {
  const organizationSeq = (await created('/api/companies', { name: '일괄 삭제 ' + randomUUID() }))
    .organizationSeq;
  const departmentSeq = (
    await created(`/api/companies/${organizationSeq}/departments`, { name: '개발팀' })
  ).departmentSeq;
  const customerSeq = (
    await created('/api/customers', {
      name: '보존 고객',
      phoneNumber: '010' + randomInt(10000000, 100000000),
      address: customerAddress(),
    })
  ).customerSeq;
  assert.equal(
    (
      await f.write('POST', `/api/companies/${organizationSeq}/members`, {
        customerSeq,
        employeeNo: '001',
        role: 'MEMBER',
        departmentSeq,
      })
    ).status,
    204,
  );
  return { organizationSeq, departmentSeq, customerSeq };
}
const remove = (ids, actor = 0, headers = {}) =>
  f.write('DELETE', '/api/companies', { organizationSeqs: ids }, actor, headers);
async function state(companies) {
  const ids = companies.map((c) => c.organizationSeq);
  return (
    await f.pool.query(
      `SELECT jsonb_build_object('companies',(SELECT jsonb_agg(o ORDER BY organization_seq) FROM organizations o WHERE organization_seq=ANY($1::int[])),
     'departments',(SELECT jsonb_agg(d ORDER BY department_seq) FROM departments d WHERE organization_seq=ANY($1::int[])),
     'members',(SELECT jsonb_agg(m ORDER BY membership_seq) FROM memberships m WHERE organization_seq=ANY($1::int[]))) AS data`,
      [ids],
    )
  ).rows[0].data;
}
async function success(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
async function noSuccessfulAudits(requestId) {
  assert.equal(
    (
      await f.pool.query("SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        requestId,
      ])
    ).rowCount,
    0,
  );
}

test('one-element arrays and multiple companies use existing soft deletion and preserve customers, orders and calls', async () => {
  const first = await company(),
    second = await company();
  const order = (
    await f.pool.query(
      "INSERT INTO orders(customer_seq,status) VALUES($1,'COLLECTING') RETURNING order_seq",
      [first.customerSeq],
    )
  ).rows[0].order_seq;
  const call = (
    await f.pool.query(
      'INSERT INTO call_sessions(provider_call_id,customer_seq,order_seq) VALUES($1,$2,$3) RETURNING call_session_seq',
      ['bulk-' + randomUUID(), first.customerSeq, order],
    )
  ).rows[0].call_session_seq;
  const history = async () =>
    (
      await f.pool.query(
        `SELECT jsonb_build_object('customer',(SELECT to_jsonb(c) FROM customers c WHERE customer_seq=$1),
     'order',(SELECT to_jsonb(o) FROM orders o WHERE order_seq=$2),'call',(SELECT to_jsonb(c) FROM call_sessions c WHERE call_session_seq=$3)) AS data`,
        [first.customerSeq, order, call],
      )
    ).rows[0].data;
  const before = await history();
  const requestId = randomUUID();
  await success(
    await remove([second.organizationSeq, first.organizationSeq], 0, { 'X-Request-Id': requestId }),
  );
  const deleted = await state([first, second]);
  for (const rows of Object.values(deleted)) {
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.deleted_at !== null));
  }
  assert.deepEqual(await history(), before);
  const audits = (
    await f.pool.query(
      "SELECT action,target_seq,actor_seq FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",
      [requestId],
    )
  ).rows;
  assert.equal(audits.length, 6);
  assert.ok(audits.every((row) => row.actor_seq === f.ids[0]));
  assert.deepEqual(
    audits
      .filter((row) => row.action === 'ORGANIZATION_DELETED')
      .map((row) => row.target_seq)
      .sort((a, b) => a - b),
    [first.organizationSeq, second.organizationSeq],
  );
  const one = await company();
  await success(await remove([one.organizationSeq]));
  assert.ok((await state([one])).companies[0].deleted_at);
});

test('a missing or already deleted company rolls back every selected company and successful audit', async () => {
  const kept = await company(),
    removed = await company();
  await success(await remove([removed.organizationSeq]));
  for (const missing of [2147483647, removed.organizationSeq]) {
    const before = await state([kept]);
    const requestId = randomUUID();
    await f.error(
      await remove([missing, kept.organizationSeq], 0, { 'X-Request-Id': requestId }),
      404,
      'NOT_FOUND',
    );
    assert.deepEqual(await state([kept]), before);
    await noSuccessfulAudits(requestId);
  }
});

test('a failure auditing the second company rolls back both company graphs', async () => {
  const first = await company(),
    second = await company();
  const before = await state([first, second]);
  const audit = f.app.get(AuditService),
    original = audit.recordSuccess;
  const requestId = randomUUID();
  audit.recordSuccess = function (event, client) {
    if (event.action === 'ORGANIZATION_DELETED' && event.targetId === second.organizationSeq)
      throw new Error('synthetic second company audit failure');
    return original.call(this, event, client);
  };
  try {
    const response = await remove([second.organizationSeq, first.organizationSeq], 0, {
      'X-Request-Id': requestId,
    });
    assert.equal(response.status, 500, await response.clone().text());
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await state([first, second]), before);
  await noSuccessfulAudits(requestId);
});

test('a locked member in a later company prevents partial deletion and permits retry after release', async () => {
  const first = await company(),
    second = await company();
  const before = await state([first, second]);
  const blocker = await f.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM customers WHERE customer_seq=$1 FOR UPDATE', [
      second.customerSeq,
    ]);
    await f.error(
      await remove([second.organizationSeq, first.organizationSeq]),
      409,
      'REQUEST_IN_PROGRESS',
    );
    assert.deepEqual(await state([first, second]), before);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  await success(await remove([second.organizationSeq, first.organizationSeq]));
});

test('overlapping reversed batches serialize and the failed batch preserves its exclusive company', async () => {
  const shared = await company(),
    left = await company(),
    right = await company();
  const responses = await Promise.all([
    remove([left.organizationSeq, shared.organizationSeq]),
    remove([right.organizationSeq, shared.organizationSeq]),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [204, 404]);
  const rows = (await state([shared, left, right])).companies;
  assert.equal(rows.filter((row) => row.deleted_at !== null).length, 2);
  const loser = responses[0].status === 404 ? left : right;
  assert.equal(rows.find((row) => row.organization_seq === loser.organizationSeq).deleted_at, null);
});

test('array inputs reject empty, duplicate, coerced, unbounded and extra fields without changing the company', async () => {
  const kept = await company();
  const before = await state([kept]);
  for (const body of [
    null,
    [],
    {},
    { organizationSeqs: [] },
    { organizationSeqs: [kept.organizationSeq, kept.organizationSeq] },
    { organizationSeqs: ['1'] },
    { organizationSeqs: [true] },
    { organizationSeqs: [0] },
    { organizationSeqs: [1.5] },
    { organizationSeqs: [2147483648] },
    { organizationSeqs: Array.from({ length: 101 }, (_, i) => i + 1) },
    { organizationSeqs: [kept.organizationSeq], extra: true },
  ])
    await f.error(await f.write('DELETE', '/api/companies', body), 400, 'INVALID_REQUEST');
  assert.deepEqual(await state([kept]), before);
});

test('all administrator roles can delete arrays while session and Origin checks remain required', async () => {
  const kept = await company();
  await f.error(
    await remove([kept.organizationSeq], 0, { Cookie: undefined }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(
    await remove([kept.organizationSeq], 0, { Cookie: undefined, ...businessHeaders() }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(await remove([kept.organizationSeq], 0, { Origin: undefined }), 403, 'FORBIDDEN');
  for (let actor = 0; actor < 3; actor++) {
    const row = await company();
    await success(await remove([row.organizationSeq], actor));
  }
  await success(await f.write('DELETE', `/api/companies/${kept.organizationSeq}`));
});

test('the documented 100-company limit succeeds atomically and both delete contracts remain in Swagger', async () => {
  const ids = (
    await f.pool.query(
      "INSERT INTO organizations(name,status) SELECT $1::text||n,'ACTIVE' FROM generate_series(1,100) AS n RETURNING organization_seq",
      ['bulk-limit-' + randomUUID()],
    )
  ).rows.map((row) => row.organization_seq);
  await success(await remove(ids.reverse()));
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM organizations WHERE organization_seq=ANY($1::int[]) AND deleted_at IS NOT NULL',
        [ids],
      )
    ).rowCount,
    100,
  );
  const response = await f.get('/api/docs-json');
  assert.equal(response.status, 200);
  const spec = await response.json();
  assert.ok(spec.paths['/api/companies'].delete);
  assert.ok(spec.paths['/api/companies/{id}'].delete);
  const field = spec.components.schemas.DeleteOrganizationsDto.properties.organizationSeqs;
  assert.equal(field.minItems, 1);
  assert.equal(field.maxItems, 100);
  assert.equal(field.uniqueItems, true);
});
