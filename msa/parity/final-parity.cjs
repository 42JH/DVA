const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const assert = require('node:assert/strict');

function msaRoutes(root) {
  const routes = [];
  for (const service of ['operations', 'customer', 'consultation', 'order', 'delivery']) {
    const directory = join(root, 'msa/services', service, 'src');
    for (const name of readdirSync(directory, { recursive: true }).sort()) {
      if (!name.endsWith('.controller.ts')) continue;
      const file = join(directory, name), text = readFileSync(file, 'utf8');
      const controller = /@Controller\((?:'([^']*)')?\)/.exec(text);
      assert.ok(controller, 'Unsupported controller: ' + file);
      for (const match of text.matchAll(/@(Get|Post|Patch|Put|Delete|Sse)\((?:'([^']*)')?\)/g)) {
        const path = [controller[1], match[2]].filter(Boolean).join('/');
        const prefix = path === 'health' || path === 'health/ready' ? service + '/'
          : /^(internal\/|webhooks\/|\w+\/health)/.test(path) ? '' : 'api/';
        routes.push({ method: match[1] === 'Sse' ? 'GET' : match[1].toUpperCase(), path: '/' + prefix + path,
          service, stream: match[1] === 'Sse', file: relative(root, file).replaceAll('\\', '/') });
      }
    }
  }
  const keys = routes.map(route => route.service + ' ' + route.method + ' ' + route.path);
  assert.equal(new Set(keys).size, keys.length, 'Duplicate MSA route declaration');
  return routes;
}

function coverage(reference, candidate) {
  const key = route => [route.service, route.method, route.path].join(' ');
  const keys = new Set(candidate.map(key));
  return reference.map(route => ({ ...route, declared: keys.has(key(route)) }));
}

function envelope(value, requestId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = structuredClone(value);
  if (result.meta) {
    assert.equal(result.meta.requestId, requestId);
    if (result.meta.timestamp !== undefined) {
      assert.ok(Number.isFinite(Date.parse(result.meta.timestamp)));
      result.meta.timestamp = '<valid response timestamp>';
    }
  }
  return result;
}

function schema(value, document, visited = new Set()) {
  if (Array.isArray(value)) return value.map(item => schema(item, document, visited));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    assert.ok(value.$ref.startsWith('#/components/schemas/'), 'Unsupported OpenAPI reference');
    if (visited.has(value.$ref)) return { $ref: value.$ref };
    const resolved = document.components.schemas[value.$ref.split('/').at(-1)];
    assert.ok(resolved, 'Unresolved OpenAPI reference: ' + value.$ref);
    return schema(resolved, document, new Set([...visited, value.$ref]));
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['description', 'summary', 'example', 'examples', 'operationId', 'tags'].includes(key))
    .map(([key, item]) => [key, schema(item, document, visited)]));
}

function generatedTimes(value, start, end, key = '') {
  const fields = ['createdAt', 'updatedAt', 'created_at', 'updated_at'];
  if (value instanceof Date) value = value.toISOString();
  if (fields.includes(key) && typeof value === 'string') {
    const time = Date.parse(value);
    if (time >= start && time <= end) return '<time generated during this flow>';
  }
  if (Array.isArray(value)) return value.map(item => generatedTimes(item, start, end));
  if (!value || typeof value !== 'object') return value;
  const created = value.createdAt ?? value.created_at, updated = value.updatedAt ?? value.updated_at;
  const epoch = item => item instanceof Date ? item.getTime() : Date.parse(item);
  if (created != null && updated != null) assert.ok(epoch(updated) >= epoch(created), 'Update precedes creation');
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, generatedTimes(item, start, end, field)]));
}

function countSnapshot(value, start, end) {
  assert.ok(Number.isSafeInteger(value.activeCallCount) && value.activeCallCount >= 0);
  const observed = Date.parse(value.observedAt);
  assert.ok(observed >= start - 15000 && observed <= end + 1000, 'Stale or invalid active-count snapshot');
  return { ...value, observedAt: '<validated snapshot time>' };
}

module.exports = { msaRoutes, coverage, envelope, schema, generatedTimes, countSnapshot };

async function main() {
  require('reflect-metadata');
  const { writeFileSync } = require('node:fs');
  const { randomUUID, createHash } = require('node:crypto');
  const { Pool } = require('pg');
  const { hashPassword } = require('../dist/auth/password');
  const baseline = require('./initial-baseline.json');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const ports = { monolith: 3000, operations: 3005, customer: 3001, consultation: 3004, order: 3002, delivery: 3003 };
  const bases = Object.fromEntries(Object.entries(ports).map(([owner, port]) => [owner, `http://${owner}-app:${port}`]));
  const databases = Object.fromEntries(Object.keys(ports).map(owner => [owner, new Pool({ host: owner + '-db' })]));
  const report = { passed: false, initialCommit: baseline.commit,
    verifierSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    readiness: {}, routes: [], comparisons: [], flows: [],
    database: [], unverified: ['Every valid branch, rollback and race of all initial APIs',
      'Payment/dispatch/FAQ-example events and complete cross-owner retention recovery'] };
  const cookie = 'dva_session=' + 'a'.repeat(64), origin = 'http://localhost:5173';
  const token = process.env.FINAL_SERVICE_TOKEN;
  const documents = {};
  const requestIds = [];
  const ownerFor = table => table === 'organization_billing_months' ? 'order'
    : /^(admin_|audit_|ai_persona|faq_)/.test(table) ? 'operations'
    : /^(customer|organization|department|membership|personal_pin|company_pin)/.test(table) ? 'customer'
    : /^(call_|unanswered_)/.test(table) ? 'consultation'
    : /^(shipment)/.test(table) ? 'delivery' : 'order';
  const tables = ['customers', 'organizations', 'departments', 'memberships', 'personal_pins', 'call_sessions',
    'call_analyses', 'call_insight_events', 'unanswered_questions', 'orders', 'order_parcels',
    'order_payment_requests', 'order_billing_charges', 'organization_billing_months', 'shipments',
    'shipment_status_history', 'faq_entries', 'faq_question_examples'];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let flowStarted;

  function same(left, right) {
    if (left?.transportError || right?.transportError) return false;
    try {
      if (flowStarted) {
        const end = Date.now() + 1000;
        left = generatedTimes(left, flowStarted - 1000, end);
        right = generatedTimes(right, flowStarted - 1000, end);
      }
      assert.deepEqual(left, right); return true;
    } catch { return false; }
  }
  function note(name, left, right, extra = {}) {
    const item = { name, equal: same(left, right), reference: left, candidate: right, ...extra };
    report.comparisons.push(item);
    return item;
  }
  async function firstEvent(response) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const part = await reader.read();
        assert.ok(!part.done, 'SSE closed without its initial event');
        buffer += decoder.decode(part.value, { stream: true }).replaceAll('\r\n', '\n');
        while (buffer.includes('\n\n')) {
          const end = buffer.indexOf('\n\n'), block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data) return { event: block.match(/^event:\s*(.+)$/m)?.[1] ?? 'message', data: JSON.parse(data) };
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function request(owner, method, path, options, requestId) {
    const headers = { 'X-Request-Id': requestId, ...(options.origin === false ? {} : { Origin: options.origin ?? origin }),
      ...(options.admin ? { Cookie: cookie } : {}), ...(options.ai ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers };
    try {
      const started = Date.now();
      const response = await fetch(bases[owner] + path, { method, headers, redirect: 'manual',
        signal: AbortSignal.timeout(8000), ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
      assert.equal(response.headers.get('x-request-id'), requestId);
      const selected = Object.fromEntries(['content-type', 'cache-control', 'location', 'x-request-id',
        'access-control-allow-origin', 'access-control-allow-credentials', 'retry-after'].map(key => [key, response.headers.get(key)]));
      const type = response.headers.get('content-type') ?? '';
      const body = type.includes('text/event-stream') ? await firstEvent(response)
        : type.includes('application/json') ? envelope(await response.json(), requestId) : await response.text();
      if (response.status === 200 && path.startsWith('/api/calls/active-count')) {
        if (type.includes('text/event-stream')) assert.equal(body.event, 'active-call-count');
        body.data = countSnapshot(body.data, started, Date.now());
      }
      return { status: response.status, headers: selected, body };
    } catch (error) { return { transportError: error.name + ': ' + error.message }; }
  }
  async function pair(name, owner, method, path, options = {}) {
    const requestId = randomUUID();
    requestIds.push(requestId);
    const results = [];
    for (const side of ['monolith', owner]) results.push(await request(side, method, path, options, requestId));
    if (path === '/api/auth/logout') {
      for (const db of [databases.monolith, databases.operations])
        await db.query(`INSERT INTO admin_sessions(session_token_hash,admin_user_seq,created_at,expires_at)
          VALUES($1,1,'2026-11-05T00:00:00Z','2094-01-01T00:00:00Z') ON CONFLICT(session_token_hash) DO NOTHING`,
        [createHash('sha256').update('a'.repeat(64)).digest('hex')]);
    }
    return note(name, ...results);
  }
  async function columns(db, table) {
    return (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(row => row.column_name);
  }
  async function snapshot(db, selected) {
    const result = {};
    for (const [table, fields] of Object.entries(selected)) {
      result[table] = (await db.query('SELECT ' + fields.map(field => '"' + field + '"').join(',') +
        ' FROM "' + table + '"')).rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return result;
  }
  try {
    for (const owner of Object.keys(ports)) {
      const path = owner === 'monolith' ? '/api/docs-json' : '/' + owner + '/docs-json';
      for (let attempt = 0;; attempt++) {
        try {
          const response = await fetch(bases[owner] + path, { signal: AbortSignal.timeout(2000) });
          if (response.ok) { documents[owner] = await response.json(); break; }
        } catch {}
        assert.ok(attempt < 120, owner + ' did not start'); await pause(250);
      }
      const readyPath = owner === 'monolith' ? '/health/ready' : '/' + owner + '/health/ready';
      const ready = await fetch(bases[owner] + readyPath, { signal: AbortSignal.timeout(10000) });
      report.readiness[owner] = ready.status;
      assert.equal(ready.status, 200, owner + ' readiness failed');
    }
    const rootHash = await hashPassword('final-parity-local-password');
    for (const db of [databases.monolith, databases.operations]) {
      await db.query(`INSERT INTO admin_users(admin_user_seq,login_id,name,password_hash,role,status,created_at)
        OVERRIDING SYSTEM VALUE VALUES(1,'finalroot','최종 검증 관리자',$1,'SYSTEM_ADMIN','ACTIVE','2026-11-05T00:00:00Z')`, [rootHash]);
      await db.query(`INSERT INTO admin_sessions(session_token_hash,admin_user_seq,created_at,expires_at)
        VALUES($1,1,'2026-11-05T00:00:00Z','2094-01-01T00:00:00Z')`, [createHash('sha256').update('a'.repeat(64)).digest('hex')]);
      await db.query("SELECT setval(pg_get_serial_sequence('admin_users','admin_user_seq'),1,true)");
    }
    const address = { roadAddress: '검증로 1', jibunAddress: '검증동 1', dongName: '검증동', postalCode: '00001', detailAddress: '' };
    for (const db of [databases.monolith, databases.customer]) {
      await db.query(`INSERT INTO customers(customer_seq,name,phone_number,status,address_data,monthly_billing_enabled)
        OVERRIDING SYSTEM VALUE VALUES(1,'최초 기준 고객','01000000001','ACTIVE',$1,true)`, [address]);
      await db.query("SELECT setval(pg_get_serial_sequence('customers','customer_seq'),1,true)");
    }
    for (const db of [databases.monolith, databases.consultation]) {
      await db.query(`INSERT INTO call_sessions(call_session_seq,provider_call_id,caller_phone_number,customer_seq,incoming_at,registered_at)
        OVERRIDING SYSTEM VALUE VALUES(1,'final-seeded-call','01000000001',1,'2026-11-05T00:00:00Z','2026-11-05T00:00:00Z')`);
      await db.query("SELECT setval(pg_get_serial_sequence('call_sessions','call_session_seq'),1,true)");
    }
    const projections = Object.fromEntries(Object.keys(ports).map(owner => [owner, {}]));
    report.unverifiedTables = (await databases.monolith.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
    )).rows.map(row => row.table_name).filter(table => !tables.includes(table));
    for (const table of tables) {
      const owner = ownerFor(table), initial = await columns(databases.monolith, table), candidate = await columns(databases[owner], table);
      assert.ok(initial.length, 'Missing initial fixture table: ' + table);
      report.database.push({ table, owner, missingFields: initial.filter(field => !candidate.includes(field)),
        additionalFields: candidate.filter(field => !initial.includes(field)) });
      const common = initial.filter(field => candidate.includes(field));
      if (common.length) { projections.monolith[table] = common; projections[owner][table] = common; }
    }
    const candidateRoutes = [];
    for (const [service, document] of Object.entries(documents)) {
      if (service === 'monolith') continue;
      for (const [path, methods] of Object.entries(document.paths)) {
        for (const method of Object.keys(methods)) {
          if (['get', 'post', 'put', 'patch', 'delete'].includes(method))
            candidateRoutes.push({ service, method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') });
        }
      }
    }
    report.routes = coverage(baseline.inventory.routes, candidateRoutes);
    const initialRows = await snapshot(databases.monolith, projections.monolith), initialCandidateRows = {};
    for (const owner of Object.keys(ports).filter(owner => owner !== 'monolith'))
      Object.assign(initialCandidateRows, await snapshot(databases[owner], projections[owner]));
    note('identical initial business rows', initialRows, initialCandidateRows);
    for (const [index, route] of report.routes.entries()) {
      const path = route.path.replace(':id', '2147483647').replace(':name', 'payment.js');
      const operationPath = route.path.replace(/:([^/]+)/g, '{$1}');
      const initialOperation = documents.monolith.paths[operationPath]?.[route.method.toLowerCase()];
      const candidateOperation = documents[route.service].paths[operationPath]?.[route.method.toLowerCase()];
      if (initialOperation && candidateOperation) note('OpenAPI ' + route.method + ' ' + route.path,
        schema(initialOperation, documents.monolith), schema(candidateOperation, documents[route.service]));
      const isAi = route.path.startsWith('/api/ai/'), isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(route.method);
      for (const mode of ['anonymous', 'authorized', 'forbidden-origin']) {
        const item = await pair(mode + ' ' + route.method + ' ' + route.path, route.service, route.method, path,
          { admin: mode !== 'anonymous', ai: isAi && mode !== 'anonymous',
            ...(mode === 'forbidden-origin' ? { origin: 'https://not-allowed.invalid' } : {}),
            ...(isWrite && route.method !== 'DELETE' ? { body: {} } : {}) });
        if (!route.path.startsWith('/api/') && mode === 'authorized' && item.candidate.status !== 404 && !item.candidate.transportError)
          route.observedOutsideOpenApi = true;
      }
      if (index % 10 === 0) console.log('routes ' + (index + 1) + '/' + report.routes.length);
    }
    const before = await snapshot(databases.monolith, projections.monolith);
    const candidateBeforeFlows = {};
    for (const owner of Object.keys(ports).filter(owner => owner !== 'monolith'))
      Object.assign(candidateBeforeFlows, await snapshot(databases[owner], projections[owner]));
    note('reference read/invalid-request probes leave business rows unchanged', initialRows, before);
    note('candidate read/invalid-request probes leave business rows unchanged', initialCandidateRows, candidateBeforeFlows);
    flowStarted = Date.now();
    const flow = async (name, owner, method, path, body, options = {}) => {
      const item = await pair('flow ' + name, owner, method, path, { admin: true, ...(body === undefined ? {} : { body }), ...options });
      report.flows.push({ name, referenceStatus: item.reference.status, candidateStatus: item.candidate.status, equal: item.equal });
      return item;
    };
    await flow('existing customer read', 'customer', 'GET', '/api/customers/1');
    await flow('caller context read with original MVP credentials', 'customer', 'POST', '/api/customers/context', { phoneNumber: '01000000001' }, { admin: false });
    await flow('original customer creation without optional address', 'customer', 'POST', '/api/customers',
      { name: '최초 주소 생략 고객', phoneNumber: '01000000002' });
    await flow('original phone format', 'customer', 'POST', '/api/customers',
      { name: '최초 전화 형식 고객', phoneNumber: '021234567', address });
    await flow('registered customer address update', 'customer', 'PATCH', '/api/customers/1', { address: { ...address, roadAddress: '변경로 2' } });
    await flow('registered customer read immediately', 'customer', 'GET', '/api/customers/1');
    const pin = await flow('personal PIN creation', 'customer', 'POST', '/api/customers/1/pins',
      { label: '최종 검증 PIN', addressData: { name: '최초 기준 고객', phoneNumber: '01000000001', ...address } });
    assert.equal(pin.reference.status, 201, 'The original PIN fixture must succeed');
    await flow('personal PIN immediately visible', 'customer', 'GET', '/api/customers/1/pins');
    await flow('FAQ batch creation', 'operations', 'POST', '/api/faqs',
      { items: [{ category: '접수', question: '최초 기준 검증 질문', answer: '최초 기준 검증 답변' }] });
    await flow('FAQ immediately visible', 'operations', 'GET', '/api/faqs?q=' + encodeURIComponent('최초 기준 검증 질문'));
    await flow('persona list', 'operations', 'GET', '/api/personas');
    const incomingAt = new Date().toISOString();
    await flow('call registration with original MVP credentials', 'customer', 'POST', '/api/customers/context',
      { phoneNumber: '01000000001', call: { providerCallId: 'final-original-call', incomingAt } }, { admin: false });
    const created = await flow('AI collecting order creation', 'order', 'POST', '/api/orders',
      { customerSeq: 1, parcels: [{ origin: { name: '최초 기준 고객', phoneNumber: '01000000001', ...address }, smallBoxCount: 1 }] },
      { admin: false, origin: false, headers: { 'Idempotency-Key': randomUUID(), call_session_seq: '1' } });
    assert.equal(created.reference.status, 201, 'The original collecting-order fixture must succeed');
    if (created.reference.status === 201) {
      const orderId = created.reference.body.data.orderSeq;
      await flow('new order immediately visible', 'order', 'GET', '/api/orders/' + orderId);
    }
    const manual = await flow('admin credit order creation with Dver response', 'order', 'POST', '/api/admin/orders',
      { customerSeq: 1, paymentMethodType: 'credit', totalAmount: 3500,
        pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
        parcels: [{ origin: { name: '최초 기준 고객', phoneNumber: '01000000001', ...address },
          destination: { name: '최초 기준 고객', phoneNumber: '01000000001', ...address },
          smallBoxCount: 1, itemPrice: 10000, notifiedPrice: 3500 }] }, { headers: { 'Idempotency-Key': randomUUID() } });
    assert.equal(manual.reference.status, 201, 'The original manual-order fixture must succeed');
    await flow('post-write order list', 'order', 'GET', '/api/orders');
    await flow('post-write call list', 'consultation', 'GET', '/api/calls');
    await flow('post-write dashboard', 'consultation', 'GET', '/api/dashboard/stage-dropoffs');
    const referenceRows = await snapshot(databases.monolith, projections.monolith), candidateRows = {};
    for (const owner of Object.keys(ports).filter(owner => owner !== 'monolith'))
      Object.assign(candidateRows, await snapshot(databases[owner], projections[owner]));
    for (const table of Object.keys(referenceRows)) note('DB business rows ' + table, referenceRows[table], candidateRows[table],
      { initialCount: before[table].length });
    const auditSql = `SELECT actor_type,actor_seq,actor_name,action,target_type,target_seq,target_admin_name,request_id,result,metadata
      FROM audit_logs WHERE request_id=ANY($1::uuid[]) ORDER BY request_id,action,target_type,target_seq,result,actor_type,actor_seq`;
    note('immediately visible audit business records', (await databases.monolith.query(auditSql, [requestIds])).rows,
      (await databases.operations.query(auditSql, [requestIds])).rows);
    report.externalCalls = {};
    for (const owner of ['monolith', 'operations', 'order']) {
      const response = await fetch(`http://${owner}-app:8000/__requests`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      report.externalCalls[owner] = await response.json();
    }
    note('Dver dispatch count', report.externalCalls.monolith.filter(call => call.path === '/parcel').length,
      report.externalCalls.order.filter(call => call.path === '/parcel').length);
    const declaredOrObserved = report.routes.filter(route => route.declared || route.observedOutsideOpenApi);
    report.summary = { routes: report.routes.length, available: declaredOrObserved.length,
      missing: report.routes.filter(route => !route.declared && !route.observedOutsideOpenApi).map(route => route.method + ' ' + route.path),
      comparisons: report.comparisons.length, equal: report.comparisons.filter(item => item.equal).length,
      different: report.comparisons.filter(item => !item.equal).length };
    report.passed = report.summary.missing.length === 0 && report.summary.different === 0 &&
      report.database.every(table => table.missingFields.length === 0) &&
      report.unverified.length === 0 && report.unverifiedTables.length === 0;
    console.log(JSON.stringify(report.summary, null, 2));
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    await Promise.all(Object.values(databases).map(db => db.end()));
    writeFileSync('/app/final-parity-report.json', JSON.stringify(report, null, 2) + '\n');
  }
  return report.passed ? 0 : 1;
}

if (require.main === module) main().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
