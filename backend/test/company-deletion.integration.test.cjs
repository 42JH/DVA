const { seedTestCard, configureTestCardPayments } = require('./helpers/payment-cards.cjs');
const customerAddress = require('./helpers/customer-address.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestSession, createTestPool } = require('./helpers/application.cjs');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
const { configureApplication } = require('../dist/configure-application');

const { DverClient } = require('../dist/orders/dver.client');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');
const {
  OrganizationBillingService,
} = require('../dist/organizations/organization-billing.service');
const { AuditService } = require('../dist/audit/audit.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['127.0.0.1', 'db'].includes(process.env.DB_HOST));
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const pool = createTestPool();
const origin = 'http://localhost:5173';
let app,
  base,
  cookie,
  adminId,
  reply = 'ACCEPTED',
  dverHook;
let phoneSequence = randomInt(10000000, 80000000);
const address = {
  name: '배송 담당',
  phoneNumber: '01000103001',
  roadAddress: '보존로 1',
  jibunAddress: '보존동 1',
  detailAddress: '',
  dongName: '보존동',
  postalCode: '01030',
};
async function request(method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
before(async () => {
  await migrate(pool);
  adminId = (
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('deletion1030','삭제 운영자',$1,'SYSTEM_ADMIN','ACTIVE') ON CONFLICT(login_id) WHERE deleted_at IS NULL DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING admin_user_seq",
      ['not-for-login'],
    )
  ).rows[0].admin_user_seq;
  app = await NestFactory.create(AppModule, { logger: false });
  configureTestCardPayments(app);
  const dver = app.get(DverClient);
  dver.ensureConfigured = () => {};
  dver.submit = async () => {
    await dverHook?.();
    return reply === 'ACCEPTED'
      ? { status: 'ACCEPTED', parcelNo: 'MOCK1030', receivedAt: new Date().toISOString() }
      : { status: 'SUBMISSION_FAILED' };
  };
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api';
  cookie = await createTestSession(pool, adminId);
});
after(async () => {
  await app?.close();
  await pool.end();
});

async function fixture() {
  const company = (
    await request('POST', '/companies', { name: '기록 보존 기업', monthlyBillingEnabled: true })
  ).body.data.organizationSeq;
  await seedTestCard(pool, 'ORGANIZATION', company);
  const department = (
    await request('POST', `/companies/${company}/departments`, {
      name: '개발팀',
      groupBillingEnabled: true,
    })
  ).body.data.departmentSeq;
  const phone = '010' + phoneSequence++;
  const customer = (
    await request('POST', '/customers', {
      address: customerAddress(),
      name: '소속 개인',
      phoneNumber: phone,
    })
  ).body.data.customerSeq;
  assert.equal(
    (
      await request('POST', `/companies/${company}/members`, {
        customerSeq: customer,
        employeeNo: 'EMP-1',
        groupBillingEnabled: true,
        role: 'MEMBER',
        departmentSeq: department,
      })
    ).status,
    204,
  );
  const member = (
    await pool.query('SELECT membership_seq FROM memberships WHERE customer_seq=$1', [customer])
  ).rows[0].membership_seq;
  return { company, department, customer, member, phone };
}
async function order(f, method = 'credit', fields = {}) {
  const result = await request(
    'POST',
    '/admin/orders',
    {
      customerSeq: f.customer,
      paymentMethodType: method,
      pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
      totalAmount: 5000,
      parcels: [
        {
          origin: address,
          destination: address,
          smallBoxCount: 1,
          notifiedPrice: 5000,
          itemPrice: 1,
        },
      ],
      ...fields,
    },
    { 'Idempotency-Key': randomUUID() },
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.data;
}
async function detail(id) {
  return (await request('GET', `/orders/${id}`)).body.data;
}

test('department rename preserves membership identities without synchronizing retired PINs', async () => {
  const f = await fixture();
  const before = (await request('GET', `/companies/${f.company}/members`)).body;
  assert.equal(
    (await request('PATCH', '/departments/' + f.department, { name: '플랫폼팀' })).status,
    204,
  );
  assert.deepEqual((await request('GET', `/companies/${f.company}/members`)).body, before);
  const stored = (
    await pool.query('SELECT organization_seq,name FROM departments WHERE department_seq=$1', [
      f.department,
    ])
  ).rows[0];
  assert.equal(stored.organization_seq, f.company);
  assert.equal(stored.name, '플랫폼팀');
});

test('settled company and department names are snapshots independent of subsequent renames', async () => {
  const f = await fixture();
  const created = await order(f, 'groupBilling');
  const before = await detail(created.orderSeq);
  assert.equal(before.billingOrganizationSeq, f.company);
  assert.equal(before.billingDepartmentSeq, f.department);
  assert.equal(before.billingOrganizationName, '기록 보존 기업');
  assert.equal(before.billingDepartmentName, '개발팀');
  await request('PATCH', `/companies/${f.company}`, { name: '변경된 회사' });
  await request('PATCH', `/departments/${f.department}`, { name: '변경된 팀' });
  assert.deepEqual(await detail(created.orderSeq), before);
  assert.equal(
    (await request('GET', `/companies/${f.company}/billing`)).body.data.organizationName,
    '기록 보존 기업',
  );
});

async function history(f) {
  return (
    await pool.query(
      `SELECT jsonb_build_object(
    'customer',(SELECT to_jsonb(c) FROM customers c WHERE customer_seq=$1),
    'personalPins',(SELECT jsonb_agg(to_jsonb(p) ORDER BY personal_pin_seq) FROM personal_pins p WHERE customer_seq=$1),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) FROM orders o WHERE customer_seq=$1),
    'parcels',(SELECT jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq) FROM order_parcels p JOIN orders o USING(order_seq) WHERE o.customer_seq=$1),
    'shipments',(SELECT jsonb_agg(to_jsonb(s) ORDER BY shipment_seq) FROM shipments s JOIN order_parcels p USING(order_parcel_seq) JOIN orders o USING(order_seq) WHERE o.customer_seq=$1),
    'charges',(SELECT jsonb_agg(to_jsonb(b) ORDER BY order_seq) FROM order_billing_charges b WHERE organization_seq=$2),
    'months',(SELECT jsonb_agg(to_jsonb(b) ORDER BY billing_month) FROM organization_billing_months b WHERE organization_seq=$2),
    'calls',(SELECT jsonb_agg(to_jsonb(c) ORDER BY call_session_seq) FROM call_sessions c WHERE caller_phone_number=$3),
    'utterances',(SELECT jsonb_agg(to_jsonb(u) ORDER BY call_utterance_seq) FROM call_utterances u JOIN call_sessions c USING(call_session_seq) WHERE caller_phone_number=$3),
    'recordings',(SELECT jsonb_agg(to_jsonb(r) ORDER BY recording_seq) FROM recordings r JOIN call_sessions c USING(call_session_seq) WHERE caller_phone_number=$3)
  ) AS snapshot`,
      [f.customer, f.company, f.phone],
    )
  ).rows[0].snapshot;
}

test('company soft deletion hides company data while preserving personal, order, call and billing history', async () => {
  const f = await fixture();
  const savedPin = await request('POST', `/customers/${f.customer}/pins`, { addressData: address });
  assert.equal(savedPin.status, 201);
  const pin = savedPin.body.data.personalPinSeq;
  const parcels = [
    {
      origin: address,
      destination: address,
      originPin: { scope: 'PERSONAL', pinSeq: pin },
      smallBoxCount: 1,
      notifiedPrice: 5000,
      itemPrice: 1,
    },
  ];
  const accepted = await order(f, 'credit', { parcels });
  reply = 'SUBMISSION_FAILED';
  let failed;
  try {
    failed = await order(f, 'groupBilling');
  } finally {
    reply = 'ACCEPTED';
  }
  const pending = await order(f, 'billing', { parcels });
  const call = (
    await pool.query(
      'INSERT INTO call_sessions(order_seq,provider_call_id,caller_phone_number) VALUES($1,$2,$3) RETURNING call_session_seq',
      [accepted.orderSeq, randomUUID(), f.phone],
    )
  ).rows[0].call_session_seq;
  await pool.query(
    "INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES($1,1,'CUSTOMER','보존할 상담',1)",
    [call],
  );
  await pool.query('INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2)', [
    call,
    'test/company-history-' + randomUUID() + '.webm',
  ]);
  const before = await history(f);
  const oldLogs = (
    await pool.query(
      "SELECT * FROM audit_logs WHERE target_type='ORGANIZATION' AND target_seq=$1 ORDER BY audit_log_seq",
      [f.company],
    )
  ).rows;
  const response = await request('DELETE', '/companies', { organizationSeqs: [f.company] });
  assert.equal(response.status, 204, JSON.stringify(response.body));
  assert.deepEqual(await history(f), before);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT * FROM audit_logs WHERE audit_log_seq=ANY($1::int[]) ORDER BY audit_log_seq',
        [oldLogs.map((x) => x.audit_log_seq)],
      )
    ).rows,
    oldLogs,
  );
  assert.equal((await request('GET', `/companies/${f.company}`)).status, 404);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM departments WHERE organization_seq=$1 AND deleted_at IS NULL',
        [f.company],
      )
    ).rowCount,
    0,
  );
  const context = (await request('POST', '/customers/context', { phoneNumber: f.phone })).body.data;
  assert.equal(context.customer.customerSeq, f.customer);
  assert.equal(context.membership, null);
  assert.equal(context.organization, null);
  assert.equal(context.department, null);
  assert.equal(context.companyPins.length, 0);
  assert.equal(context.personalPins.length, 1);
  assert.deepEqual(context.availablePaymentMethods, ['billing']);
  assert.equal((await request('GET', `/calls/${call}`)).status, 200);
  assert.equal(
    (await request('GET', `/calls/${call}/transcript`)).body.data[0].utteranceText,
    '보존할 상담',
  );
  const total = (await request('GET', `/companies/${f.company}/billing`)).body.data;
  assert.equal(total.monthlyAmount, 5000);
  assert.equal(total.groupBillingAmount, 5000);
  assert.equal(total.organizationName, '기록 보존 기업');
  const log = (
    await request(
      'GET',
      `/audit-logs?targetType=ORGANIZATION&targetSeq=${f.company}&action=ORGANIZATION_DELETED`,
    )
  ).body.data[0];
  assert.equal(log.actorType, 'ADMIN');
  assert.equal(log.actorLabel, '운영자');
  assert.equal(log.actorSeq, adminId);
  assert.equal(log.actorName, '삭제 운영자');
  assert.equal(log.metadata.organizationName, '기록 보존 기업');
  const events = (
    await pool.query(
      "SELECT action,target_seq,metadata FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",
      [log.requestId],
    )
  ).rows;
  assert.equal(events.filter((x) => x.action === 'COMPANY_PIN_DELETED').length, 0);
  assert.equal(events.filter((x) => x.action === 'MEMBERSHIP_REMOVED').length, 1);
  assert.equal(
    events.find((x) => x.action === 'DEPARTMENT_DELETED').metadata.departmentName,
    '개발팀',
  );
  assert.equal(
    (await request('POST', `/admin/orders/${failed.orderSeq}/retry`)).body.data.status,
    'ACCEPTED',
  );
  const payments = app.get(OrderPaymentsService);
  const paymentKey = 'delete-test-' + randomUUID();
  await payments.claimApproval(pending.paymentRequest.paymentRequestId, 5000, paymentKey);
  assert.equal(
    (
      await payments.confirmPayment(
        pending.paymentRequest.paymentRequestId,
        5000,
        paymentKey,
        randomUUID(),
      )
    ).status,
    'ACCEPTED',
  );
  assert.equal(
    (await request('GET', `/companies/${f.company}/billing`)).body.data.groupBillingAmount,
    5000,
  );
  const priorMonths = (
    await pool.query('SELECT * FROM organization_billing_months WHERE organization_seq=$1', [
      f.company,
    ])
  ).rows;
  await app.get(OrganizationBillingService).rollover(new Date(Date.now() + 35 * 86400000));
  assert.deepEqual(
    (
      await pool.query('SELECT * FROM organization_billing_months WHERE organization_seq=$1', [
        f.company,
      ])
    ).rows,
    priorMonths,
  );
  assert.equal(
    (await request('DELETE', '/companies', { organizationSeqs: [f.company] })).status,
    404,
  );
});

test('department deletion detaches only its employees and preserves other departments and settled snapshots', async () => {
  const f = await fixture();
  const other = (await request('POST', `/companies/${f.company}/departments`, { name: '영업팀' }))
    .body.data.departmentSeq;
  const coworker = (
    await request('POST', '/customers', {
      address: customerAddress(),
      name: '남는 사원',
      phoneNumber: '010' + phoneSequence++,
    })
  ).body.data.customerSeq;
  assert.equal(
    (
      await request('POST', `/companies/${f.company}/members`, {
        customerSeq: coworker,
        employeeNo: 'EMP-2',
        role: 'MEMBER',
        departmentSeq: other,
      })
    ).status,
    204,
  );
  const settled = await order(f, 'groupBilling');
  const before = await detail(settled.orderSeq);
  assert.equal(
    (await request('DELETE', '/departments', { departmentSeqs: [f.department] })).status,
    204,
  );
  assert.deepEqual(await detail(settled.orderSeq), before);
  assert.equal((await request('GET', `/companies/${f.company}`)).status, 200);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM memberships WHERE membership_seq=$1 AND deleted_at IS NULL', [
        f.member,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await request('GET', `/customers/${f.customer}`)).status, 200);
  assert.equal(
    (await pool.query('SELECT department_seq FROM memberships WHERE customer_seq=$1', [coworker]))
      .rows[0].department_seq,
    other,
  );
  assert.equal(
    (await request('GET', `/companies/${f.company}/departments`)).body.data[0].departmentSeq,
    other,
  );
  assert.equal(
    (await request('DELETE', '/departments', { departmentSeqs: [f.department] })).status,
    404,
  );
});

test('collecting legacy COMPANY snapshots survive deletion while current payment eligibility is still required', async () => {
  const f = await fixture();
  const draft = await request(
    'POST',
    '/orders',
    {
      customerSeq: f.customer,
      paymentMethodType: 'credit',
      pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
      totalAmount: 5000,
      parcels: [
        {
          origin: address,
          destination: address,
          smallBoxCount: 1,
          notifiedPrice: 5000,
          itemPrice: 1,
        },
      ],
    },
    { 'Idempotency-Key': randomUUID() },
  );
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.data.orderSeq;
  await pool.query(
    "UPDATE order_parcels SET origin_pin_scope='COMPANY',origin_pin_seq=901 WHERE order_seq=$1",
    [id],
  );
  const before = await detail(id);
  assert.equal(
    (await request('DELETE', '/companies', { organizationSeqs: [f.company] })).status,
    204,
  );
  assert.deepEqual(await detail(id), before);
  assert.equal(
    (await request('POST', `/orders/${id}/submit`, { expectedVersion: before.version })).status,
    403,
  );
  assert.equal(
    (
      await request('PATCH', `/orders/${id}`, {
        expectedVersion: before.version,
        paymentMethodType: 'billing',
      })
    ).status,
    200,
  );
  const current = await detail(id);
  assert.deepEqual(current.parcels[0].originPin, before.parcels[0].originPin);
  assert.deepEqual(current.parcels[0].origin, before.parcels[0].origin);
  assert.equal(
    (await request('POST', `/orders/${id}/submit`, { expectedVersion: current.version })).body.data
      .status,
    'notPaid',
  );
});

test('detachment preserves the customer personal monthly policy without carrying company billing identity forward', async () => {
  const f = await fixture();
  assert.equal(
    (await request('PATCH', `/customers/${f.customer}`, { monthlyBillingEnabled: true })).status,
    204,
  );
  assert.equal(
    (await request('DELETE', '/departments', { departmentSeqs: [f.department] })).status,
    204,
  );
  const context = (await request('POST', '/customers/context', { phoneNumber: f.phone })).body.data;
  assert.deepEqual(context.availablePaymentMethods, ['billing', 'credit']);
  const settled = await order(f, 'credit');
  const saved = await detail(settled.orderSeq);
  assert.equal(saved.billingOrganizationSeq, null);
  assert.equal(saved.billingDepartmentSeq, null);
  const charges = await pool.query(
    'SELECT organization_seq,customer_seq,amount FROM order_billing_charges WHERE order_seq=$1',
    [settled.orderSeq],
  );
  assert.deepEqual(charges.rows, [
    { organization_seq: null, customer_seq: f.customer, amount: saved.totalAmount },
  ]);
});

test('department deletion preserves personal PINs and historical COMPANY_PIN audit events', async () => {
  const f = await fixture();
  assert.equal(
    (await request('POST', `/customers/${f.customer}/pins`, { addressData: address })).status,
    201,
  );
  const requestId = randomUUID();
  await app.get(AuditService).recordSuccess({
    actorId: adminId,
    action: 'COMPANY_PIN_CREATED',
    targetType: 'COMPANY_PIN',
    targetId: 901,
    requestId,
  });
  const before = await history(f);
  const oldAudit = (await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [requestId]))
    .rows;
  assert.equal(
    (await request('DELETE', '/departments', { departmentSeqs: [f.department] })).status,
    204,
  );
  assert.deepEqual(await history(f), before);
  assert.deepEqual(
    (await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [requestId])).rows,
    oldAudit,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM memberships WHERE membership_seq=$1 AND deleted_at IS NULL', [
        f.member,
      ])
    ).rowCount,
    0,
  );
});

test('audit failure after all company deletes rolls back the complete operation', async () => {
  const f = await fixture();
  await order(f);
  const before = await history(f),
    audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = function (event, client) {
    if (event.action === 'ORGANIZATION_DELETED') throw new Error('synthetic-audit-failure');
    return original.call(this, event, client);
  };
  try {
    assert.equal(
      (await request('DELETE', '/companies', { organizationSeqs: [f.company] })).status,
      500,
    );
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await history(f), before);
  assert.equal((await request('GET', `/companies/${f.company}`)).status, 200);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM memberships WHERE membership_seq=$1 AND deleted_at IS NULL', [
        f.member,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM departments WHERE department_seq=$1 AND deleted_at IS NULL', [
        f.department,
      ])
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE metadata->>'organizationSeq'=$1 AND result='SUCCESS' AND action IN ('ORGANIZATION_DELETED','DEPARTMENT_DELETED','COMPANY_PIN_DELETED','MEMBERSHIP_REMOVED')",
        [String(f.company)],
      )
    ).rowCount,
    0,
  );
});

test('company may disappear during the Dver HTTP request without interrupting the paid order', async () => {
  const f = await fixture();
  dverHook = async () => {
    dverHook = undefined;
    assert.equal(
      (await request('DELETE', '/companies', { organizationSeqs: [f.company] })).status,
      204,
    );
  };
  try {
    const created = await order(f, 'groupBilling');
    assert.equal(created.status, 'ACCEPTED');
    const saved = await detail(created.orderSeq);
    assert.equal(saved.billingOrganizationSeq, f.company);
    assert.equal(saved.billingDepartmentName, '개발팀');
  } finally {
    dverHook = undefined;
  }
});

test('busy customers prevent partial deletion and concurrent deletes produce one successful operation', async () => {
  const f = await fixture(),
    blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM customers WHERE customer_seq=$1 FOR UPDATE', [f.customer]);
    assert.equal(
      (await request('DELETE', '/companies', { organizationSeqs: [f.company] })).status,
      409,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT 1 FROM memberships WHERE membership_seq=$1 AND deleted_at IS NULL',
          [f.member],
        )
      ).rowCount,
      1,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  const results = await Promise.all([
    request('DELETE', '/companies', { organizationSeqs: [f.company] }),
    request('DELETE', '/companies', { organizationSeqs: [f.company] }),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [204, 404]);
});

test('deletion requires an active admin session, valid origin and valid ID; all admin roles are allowed', async () => {
  const f = await fixture();
  assert.equal(
    (await request('DELETE', '/companies', { organizationSeqs: [f.company] }, { Cookie: '' }))
      .status,
    401,
  );
  assert.equal(
    (await request('DELETE', '/departments', { departmentSeqs: [f.department] }, { Cookie: '' }))
      .status,
    401,
  );
  assert.equal(
    (await request('DELETE', '/companies', { organizationSeqs: [f.company] }, { Origin: '' }))
      .status,
    403,
  );
  assert.equal(
    (await request('DELETE', '/companies', { organizationSeqs: ['invalid'] })).status,
    400,
  );
  assert.equal((await request('DELETE', '/departments', { departmentSeqs: ['0'] })).status, 400);
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const data = await fixture();
    const loginId = 'del' + randomUUID().slice(0, 8);
    const admin = await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'역할 검증',$2,$3,'ACTIVE') RETURNING admin_user_seq",
      [loginId, 'not-for-login', role],
    );
    const token = await createTestSession(pool, admin.rows[0].admin_user_seq);
    assert.equal(
      (
        await request(
          'DELETE',
          '/departments',
          { departmentSeqs: [data.department] },
          { Cookie: token },
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await request(
          'DELETE',
          '/companies',
          { organizationSeqs: [data.company] },
          { Cookie: token },
        )
      ).status,
      204,
    );
    await pool.query("UPDATE admin_users SET status='INACTIVE' WHERE login_id=$1", [loginId]);
    assert.ok(
      [401, 403].includes(
        (
          await request(
            'DELETE',
            '/companies',
            { organizationSeqs: [f.company] },
            { Cookie: token },
          )
        ).status,
      ),
    );
  }
});

test('deleting a company without departments unlinks employees and preserves customers and credit history', async () => {
  const company = (
    await request('POST', '/companies', {
      name: '부서 없는 삭제 기업',
      monthlyBillingEnabled: true,
    })
  ).body.data.organizationSeq;
  const phone = '016' + phoneSequence++;
  const customer = (
    await request('POST', '/customers', {
      address: customerAddress(),
      name: '부서 없는 삭제 직원',
      phoneNumber: phone,
    })
  ).body.data.customerSeq;
  assert.equal(
    (
      await request('POST', `/companies/${company}/members`, {
        customerSeq: customer,
        employeeNo: 'NO-DEPT',
        role: 'MEMBER',
      })
    ).status,
    204,
  );
  const member = (
    await pool.query('SELECT membership_seq FROM memberships WHERE customer_seq=$1', [customer])
  ).rows[0].membership_seq;
  const saved = await order({ company, customer });
  assert.equal(
    (await request('DELETE', '/companies', { organizationSeqs: [company] })).status,
    204,
  );
  assert.equal((await request('GET', '/customers/' + customer)).status, 200);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM memberships WHERE customer_seq=$1 AND deleted_at IS NULL',
        [customer],
      )
    ).rows[0].count,
    '0',
  );
  assert.ok(await detail(saved.orderSeq));
  const audit = (
    await pool.query(
      "SELECT metadata FROM audit_logs WHERE action='MEMBERSHIP_REMOVED' AND target_seq=$1 AND result='SUCCESS'",
      [member],
    )
  ).rows[0];
  assert.equal(audit.metadata.departmentSeq, null);
  assert.equal(audit.metadata.departmentName, null);
});
