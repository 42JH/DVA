const { truncateFixture } = require('./fixture-reset.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { hashPassword } = require('./seed-password.cjs');

test('customer reads match monolith with independent operations sessions and immutable customer data', async t => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const reference = new Pool({ host: 'monolith-db', user: 'monolith_app' });
  const operations = new Pool({ host: 'operations-db', user: 'operations_app' });
  const customer = new Pool({ host: 'customer-db', user: 'customer_app' });
  t.after(async () => { await Promise.all([reference.end(), operations.end(), customer.end()]); });
  const sides = [
    { name: 'monolith', base: 'http://monolith-app:3000', auth: 'http://monolith-app:3000', db: reference, identity: reference, cookies: {} },
    { name: 'msa', base: 'http://customer-app:3001', auth: 'http://operations-app:3005', db: customer, identity: operations, cookies: {} },
  ];
  for (const base of [sides[0].base, sides[1].base, sides[1].auth]) {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(base+'/api/docs-json', { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* Wait for startup. */ }
      assert.ok(attempt < 60, base+' did not start');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  assert.equal((await fetch(sides[1].base+'/customer/health/ready')).status, 200);
  assert.equal((await customer.query("SELECT to_regclass('admin_users') IS NULL AND to_regclass('admin_sessions') IS NULL AS isolated")).rows[0].isolated, true);
  const password = 'read-parity-only-password';
  const hash = await hashPassword(password);
  const address = { roadAddress: '서울 도로 10', jibunAddress: '서울 지번 20', detailAddress: '3층', dongName: '역삼동', postalCode: '01234' };
  for (const side of sides) {
    await truncateFixture(side.identity, 'TRUNCATE admin_users,audit_logs RESTART IDENTITY CASCADE');
    for (const [login, role, status] of [['root','SYSTEM_ADMIN','ACTIVE'], ['operator','OPERATOR','ACTIVE'],
      ['supervisor','SUPERVISOR','ACTIVE'], ['pending','OPERATOR','PENDING'], ['inactive','OPERATOR','INACTIVE']]) {
      await side.identity.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at)
        VALUES($1,$2,$3,$4,$5,'2025-10-01T00:00:00Z')`, [login, '테스트 '+login, hash, role, status]);
    }
    await truncateFixture(side.db, 'TRUNCATE customers,organizations,departments,memberships RESTART IDENTITY CASCADE');
    for (const [name,status,deleted,created] of [['한빛 %_[회사]','ACTIVE',null,'2025-10-01T00:00:00Z'],
      ['비활성기업','INACTIVE',null,null], ['삭제기업','ACTIVE','2026-01-01T00:00:00Z',null], ['빈 기업','ACTIVE',null,null]]) {
      await side.db.query('INSERT INTO organizations(name,status,deleted_at,created_at,monthly_billing_enabled) VALUES($1,$2,$3,$4,true)', [name,status,deleted,created]);
    }
    const people = [['김가람','01000000001','ACTIVE',null,address], ['검색 %_[문자]','01000000002','ACTIVE',null,null],
      ['탈퇴고객','01000000003','WITHDRAWN',null,address], ['삭제고객','01000000004','ACTIVE','2026-01-01T00:00:00Z',address],
      ['새 고객','01000000004','ACTIVE',null,address], ['부서 없는 고객','01000000006','ACTIVE',null,address]];
    for (const row of people) await side.db.query('INSERT INTO customers(name,phone_number,status,deleted_at,address_data,monthly_billing_enabled) VALUES($1,$2,$3,$4,$5,true)', row);
    await side.db.query(`INSERT INTO departments(organization_seq,name,group_billing_enabled,created_at,deleted_at) VALUES
      (1,'연구 개발',true,'2025-10-01T00:00:00Z',NULL),(1,'삭제 부서',false,NULL,'2026-01-01T00:00:00Z'),(2,'다른 부서',false,NULL,NULL)`);
    await side.db.query(`INSERT INTO memberships(customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at) VALUES
      (1,1,1,'0007','ORG_ADMIN','ACTIVE',NULL),(2,1,NULL,'A002','MEMBER','ACTIVE',NULL),
      (3,1,1,'003','MEMBER','ACTIVE',NULL),(4,1,2,'004','MEMBER','ACTIVE',NULL),
      (5,2,3,'005','MEMBER','INACTIVE',NULL),(6,1,NULL,'006','MEMBER','ACTIVE','2026-01-01T00:00:00Z')`);
  }
  async function snapshot(db) {
    const values = [];
    for (const query of [
      'SELECT customer_seq,name,phone_number,status,monthly_billing_enabled,address_data,deleted_at,anonymized_at FROM customers ORDER BY customer_seq',
      'SELECT organization_seq,name,status,monthly_billing_enabled,created_at,deleted_at FROM organizations ORDER BY organization_seq',
      'SELECT department_seq,organization_seq,name,group_billing_enabled,created_at,deleted_at FROM departments ORDER BY department_seq',
      'SELECT membership_seq,customer_seq,organization_seq,department_seq,employee_no,role,status,deleted_at FROM memberships ORDER BY membership_seq',
    ]) values.push((await db.query(query)).rows);
    return values;
  }
  const original = await snapshot(reference);
  assert.deepEqual(await snapshot(customer), original);
  let compared = 0;
  const origin = 'http://localhost:5173';
  async function request(method, path, actor, expected, body, options = {}) {
    const id = randomUUID(), results = [];
    for (const side of sides) {
      const response = await fetch((path.startsWith('/api/auth') || path.startsWith('/api/admins') ? side.auth : side.base)+path, {
        method, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'X-Request-Id': id,
          ...((/^\/api\/customers\/\d/.test(path)||path.startsWith('/api/companies/search')) && options.ai !== false ? {Authorization:'Bearer '+(options.token ?? process.env.AI_BUSINESS_TOKEN)} : {}), ...(options.noOrigin ? {} : { Origin: options.origin ?? origin }),
          ...(actor && side.cookies[actor] ? { Cookie: options.duplicate ? side.cookies[actor]+'; '+side.cookies[actor] : side.cookies[actor] } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, expected, `${side.name} ${method} ${path}`);
      assert.equal(response.headers.get('x-request-id'), id);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const cookie = response.headers.get('set-cookie');
      if (options.login) {
        assert.match(cookie, /^dva_session=[a-f0-9]{64};/);
        assert.match(cookie, /; Path=\/api;/); assert.match(cookie, /; HttpOnly;/);
        assert.match(cookie, /; Secure;/); assert.match(cookie, /; SameSite=Lax/);
        side.cookies[options.login] = cookie.split(';')[0];
      }
      const text = await response.text(), result = text ? JSON.parse(text) : undefined;
      if (options.login) {
        const expiry = Date.parse(result.data.expiresAt);
        assert.ok(expiry > Date.now()+9*3600_000-10000 && expiry < Date.now()+9*3600_000+10000);
        result.data.expiresAt = '<valid-nine-hour-expiry>';
      }
      results.push({ body: result, origin: response.headers.get('access-control-allow-origin'),
        credentials: response.headers.get('access-control-allow-credentials'),
        cookie: cookie?.replace(/^dva_session=[^;]*/, 'dva_session=<opaque>').replace(/Expires=[^;]+/, 'Expires=<date>') });
    }
    assert.deepEqual(results[1], results[0], `${method} ${path} HTTP parity`);
    assert.deepEqual(await snapshot(customer), original, `${method} ${path} changed customer data`);
    assert.deepEqual(await snapshot(reference), original, `${method} ${path} changed monolith customer data`);
    compared++;
    return results[0].body;
  }
  const login = id => request('POST','/api/auth/login',undefined,200,{ loginId:id,password },{ login:id });
  for (const id of ['root','operator','supervisor']) await login(id);
  for (const path of ['/api/customers','/api/companies','/api/companies/1/members','/api/companies/1/departments'])
    await request('GET',path,undefined,401);
  await request('GET','/api/customers/1',undefined,200);
  await request('GET','/api/customers/3',undefined,404);
  await request('GET','/api/customers/3','operator',200);
  await request('GET','/api/customers/4','root',404);
  for (const actor of ['root','operator','supervisor']) {
    for (const path of ['/api/customers','/api/companies','/api/companies/1','/api/companies/1/members','/api/companies/1/departments'])
      await request('GET',path,actor,200);
  }
  for (const path of ['/api/customers?q=%25_%5B','/api/customers?phoneNumber=01000000004',
    '/api/customers?status=WITHDRAWN','/api/customers?limit=1&offset=1','/api/customers?offset=99999',
    '/api/companies?q=%25_%5B','/api/companies?status=INACTIVE','/api/companies?limit=1&offset=99999',
    '/api/companies/2/members?status=INACTIVE','/api/companies/1/members?limit=1&offset=99999',
    '/api/companies/4/members','/api/companies/1/departments?limit=1&offset=99999','/api/companies/4/departments'])
    await request('GET',path,'root',200);
  for (const path of ['/api/companies/search?q=한빛%20연구','/api/companies/search?q=%25_%5B',
    '/api/companies/search?q=없는주소','/api/companies/search?q=한빛&limit=1&offset=99999']) {
    const result = await request('GET',path,undefined,200);
    for (const item of result.data) for (const field of ['employeeNo','role','personalPins']) assert.equal(item[field], undefined);
  }
  await request('GET','/api/companies/search?q=한빛','root',401,undefined,{ai:false});
  await request('GET','/api/customers/1',undefined,401,undefined,{ai:false});
  await request('GET','/api/customers/1',undefined,401,undefined,{token:'wrong'});
  await request('GET','/api/companies/members/search?q=김',undefined,401);
  for(const actor of ['root','operator','supervisor']) {
    const result=await request('GET','/api/companies/members/search?q=0007',actor,200);
    assert.equal(result.total_count,1);assert.equal(result.data[0].employeeNo,'0007');
  }
  for(const [q,total] of [['검색',1],['010-0000-0002',1],['연구 김',1],['한빛',0],['서울',0],['김 없는단어',0],['새',0]]) {
    const result=await request('GET','/api/companies/members/search?q='+encodeURIComponent(q),'root',200);
    assert.equal(result.total_count,total,q);
  }
  const inactive=await request('GET','/api/companies/members/search?q=새&includeInactive=true','root',200);
  assert.equal(inactive.total_count,1);assert.equal(inactive.data[0].membershipStatus,'INACTIVE');
  const emptyPage=await request('GET','/api/companies/members/search?q=검색&limit=1&offset=100','root',200);
  assert.equal(emptyPage.total_count,1);assert.deepEqual(emptyPage.data,[]);assert.equal(emptyPage.hasNext,false);
  for(const query of ['', '?q=%20%20', '?q='+encodeURIComponent('x'.repeat(101)), '?q=a%00b','?q=a&includeInactive=1','?q=a&limit=0','?q=a&unknown=true'])
    await request('GET','/api/companies/members/search'+query,'root',400);
  for (const path of ['/api/customers?status=PENDING','/api/customers?limit=0','/api/customers?limit=101',
    '/api/customers?offset=-1','/api/customers?limit=1&limit=2','/api/customers?extra=true',
    '/api/customers/0','/api/customers/2147483648','/api/companies/invalid',
    '/api/companies?status=SUSPENDED','/api/companies/1/members?status=WITHDRAWN',
    '/api/companies/1/departments?offset=1.5','/api/companies/search?q=%20%20'])
    await request('GET',path,'root',400);
  for (const path of ['/api/companies/3','/api/companies/3/members','/api/companies/3/departments','/api/customers/99999'])
    await request('GET',path,'root',404);
  await request('GET','/api/companies','operator',200,undefined,{ noOrigin:true });
  await request('GET','/api/companies','root',403,undefined,{ origin:'https://untrusted.invalid' });
  await request('GET','/api/customers/1','operator',401,undefined,{ duplicate:true });
  await request('PATCH','/api/admins/2','root',204,{ status:'INACTIVE' });
  await request('GET','/api/customers','operator',401);
  await request('GET','/api/companies/search?q=한빛','operator',200);
  await request('GET','/api/customers/1','operator',401);
  await request('PATCH','/api/admins/2','root',204,{ status:'ACTIVE' });
  await request('GET','/api/companies','operator',401);
  await login('operator');
  await request('GET','/api/companies','operator',200);
  await request('POST','/api/auth/logout','operator',204);
  await request('GET','/api/companies/search?q=한빛','operator',200);
  await request('GET','/api/companies/search?q=한빛',undefined,200);
  await login('operator');
  await request('DELETE','/api/admins/2','root',204);
  await request('GET','/api/customers','operator',401);
  const docs = await Promise.all(sides.map(async side => (await (await fetch(side.base+'/api/docs-json')).json())));
  const schemas = new Set();
  function compareSchemas(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      assert.ok(value.$ref.startsWith('#/components/schemas/'));
      const name = value.$ref.slice('#/components/schemas/'.length);
      if (schemas.has(name)) return;
      schemas.add(name);
      assert.ok(docs[0].components.schemas[name], name+' missing reference schema');
      assert.deepEqual(docs[1].components.schemas[name], docs[0].components.schemas[name], name+' OpenAPI schema');
      compareSchemas(docs[0].components.schemas[name]);
    }
    for (const child of Object.values(value)) compareSchemas(child);
  }
  for (const path of ['/api/customers','/api/customers/{id}','/api/companies','/api/companies/search',
    '/api/companies/members/search','/api/companies/{id}','/api/companies/{id}/members','/api/companies/{id}/departments']) {
    assert.deepEqual(docs[1].paths[path].get, docs[0].paths[path].get, path+' OpenAPI');
    compareSchemas(docs[0].paths[path].get);
  }
  t.diagnostic(`${compared} identical requests compared; all seven reads preserved customer data`);
});
