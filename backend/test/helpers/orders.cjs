const { configureTestCardPayments } = require('./payment-cards.cjs');
const {
  createTestPool,
  createTestSession,
  startTestApp,
  businessHeaders,
} = require('./application.cjs');
const { legacyOrderIntake } = require('./legacy-order-intake.cjs');

module.exports = function ordersFixture() {
  const { testMembership } = require('./membership.cjs');
  require('reflect-metadata');
  const { before, after, test } = require('node:test');
  const assert = require('node:assert/strict');
  const { randomUUID } = require('node:crypto');
  const { migrate } = require('./migrations.cjs');
  const { ConfigService } = require('@nestjs/config');
  const { createServer } = require('node:http');
  const { OrderSubmissionRepository } = require('../../dist/orders/order-submission.repository');
  const { OrderPaymentsService } = require('../../dist/orders/order-payments.service');

  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  process.env.SWAGGER_ENABLED = 'false';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  const { OrdersRepository } = require('../../dist/orders/orders.repository');
  const { AuditService } = require('../../dist/audit/audit.service');
  const { DatabaseService } = require('../../dist/database/database.service');
  const pool = createTestPool();
  const apps = [],
    hosts = [],
    cookies = [];
  const origin = 'http://localhost:5173';
  let customerId,
    withdrawnId,
    otherId,
    adminId,
    repository,
    organizationId,
    personalPin,
    companyPin,
    otherPin;
  let dverServer, dverUrl, dverRespond, submissionRepository;
  let dverRequests = [];
  const dverSuccess = { ok: true, parcelNo: 'TEST0057', receivedAt: '2026-10-27T10:00:00+09:00' };
  const address = {
    name: '검증 고객',
    phoneNumber: '01000000001',
    roadAddress: '검증로 1',
    jibunAddress: '검증동 1',
    detailAddress: '',
    dongName: '검증동',
    postalCode: '00001',
  };

  before(async () => {
    await migrate(pool);
    for (const [index, role] of ['OPERATOR', 'SYSTEM_ADMIN', 'SUPERVISOR'].entries()) {
      const result = await pool.query(
        `INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'주문 검증','not-for-login',$2,'ACTIVE') RETURNING admin_user_seq`,
        [`orderTest${index}`, role],
      );
      if (index === 0) adminId = result.rows[0].admin_user_seq;
      // 두 인스턴스의 동시성 검증은 유지하고 세 번째 역할은 첫 앱에서 인증한다.
      const app = index < 2 ? legacyOrderIntake(await startTestApp(apps)) : apps[0];
      configureTestCardPayments(app);
      hosts.push(await app.getUrl());
      cookies.push(await createTestSession(pool, result.rows[0].admin_user_seq));
    }
    repository = apps[0].get(OrdersRepository);
    const customer = async (phone, status) =>
      (
        await pool.query(
          "INSERT INTO customers(name,phone_number,status) VALUES('주문 검증',$1,$2) RETURNING customer_seq",
          [phone, status],
        )
      ).rows[0].customer_seq;
    customerId = await customer('01000000001', 'ACTIVE');
    withdrawnId = await customer('01000000002', 'WITHDRAWN');
    otherId = await customer('01000000003', 'ACTIVE');
    organizationId = (
      await pool.query(
        "INSERT INTO organizations(name,status) VALUES('주문 검증 기업','ACTIVE') RETURNING organization_seq",
      )
    ).rows[0].organization_seq;
    await testMembership(pool, {
      customerSeq: customerId,
      organizationSeq: organizationId,
      employeeNo: 'order-test',
      groupBillingEnabled: true,
    });
    await pool.query(
      'UPDATE customers SET monthly_billing_enabled=true WHERE customer_seq=ANY($1::int[])',
      [[customerId, withdrawnId, otherId]],
    );
    await pool.query(
      'UPDATE organizations SET monthly_billing_enabled=true WHERE organization_seq=$1',
      [organizationId],
    );
    for (const id of [customerId, otherId]) {
      const pin = (
        await pool.query(
          'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
          [id, address],
        )
      ).rows[0].personal_pin_seq;
      if (id === customerId) personalPin = pin;
      else otherPin = pin;
    }
    // Historical order references have no FK and survive the retired table.
    companyPin = 901;
    dverServer = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      dverRequests.push({ headers: req.headers, body: JSON.parse(body) });
      dverRespond(req, res);
    });
    await new Promise((resolve) => dverServer.listen(0, '127.0.0.1', resolve));
    dverUrl = `http://127.0.0.1:${dverServer.address().port}/parcel`;
    for (const app of apps) {
      app.get(ConfigService).set('DVER_API_URL', dverUrl);
      app.get(ConfigService).set('DVER_API_KEY', 'test-only-dver-key');
    }
    submissionRepository = apps[0].get(OrderSubmissionRepository);
  });
  after(async () => {
    for (const app of apps) await app.close();
    await pool.end();
    dverServer?.closeAllConnections();
    if (dverServer) await new Promise((resolve) => dverServer.close(resolve));
  });

  const create = (body = { customerSeq: customerId }, key = randomUUID(), index = 0, extra = {}) =>
    fetch(hosts[index] + '/api/orders', {
      method: 'POST',
      headers: Object.fromEntries(
        Object.entries({
          Origin: origin,
          Cookie: cookies[index],
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...extra,
        }).filter(([, v]) => v !== undefined),
      ),
      body: JSON.stringify(body),
    });
  const counts = async () =>
    (
      await pool.query(`SELECT
  (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_parcels) AS parcels,
  (SELECT count(*) FROM orders WHERE creation_request_id IS NOT NULL) AS creationKeys,
  (SELECT count(*) FROM customers) AS customers,
  (SELECT count(*) FROM shipments) AS shipments`)
    ).rows[0];
  const errorCode = async (response, status, code) => {
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  };

  const call = async (phone = null, ended = false) =>
    (
      await pool.query(
        `INSERT INTO call_sessions(provider_call_id,caller_phone_number,started_at,ended_at,order_intake_enabled)
   VALUES($1,$2,$3,$4,false) RETURNING call_session_seq`,
        [
          randomUUID(),
          phone,
          ended ? '2026-10-27T00:00:00Z' : null,
          ended ? '2026-10-27T00:01:00Z' : null,
        ],
      )
    ).rows[0].call_session_seq;
  const aiCreate = (callId, body, key = randomUUID(), index = 0, extra = {}) =>
    create(body, key, index, {
      ...businessHeaders(),
      Cookie: undefined,
      Origin: undefined,
      call_session_seq: callId === undefined ? undefined : String(callId),
      ...extra,
    });

  const emptyAiResult = (changes = {}) => ({
    outcome: 'INCOMPLETE',
    call: {
      providerCallId: randomUUID(),
      callerPhoneNumber: '01000000001',
      incomingAt: '2026-10-27T01:00:00Z',
    },
    customerSeq: customerId,
    ...changes,
  });

  let readPhone = 580000;
  const readCustomer = async () => {
    const phone = '010' + String(++readPhone).padStart(8, '0');
    const customer = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status,monthly_billing_enabled) VALUES('조회 고객',$1,'ACTIVE',true) RETURNING customer_seq",
        [phone],
      )
    ).rows[0].customer_seq;
    return { customer, phone };
  };
  const readOrder = async (customer, parcels = []) => {
    const response = await create({ customerSeq: customer, paymentMethodType: 'billing', parcels });
    assert.equal(response.status, 201);
    return (await response.json()).data.orderSeq;
  };
  const readOrders = (query = '', extra = {}, index = 0) =>
    fetch(hosts[index] + '/api/orders' + query, {
      headers: Object.fromEntries(
        Object.entries({ Cookie: cookies[index], ...extra }).filter(([, v]) => v !== undefined),
      ),
    });
  const aiReadHeaders = (callId) => ({
    ...businessHeaders(),
    Cookie: undefined,
    call_session_seq: callId === undefined ? undefined : String(callId),
  });

  const readDetail = (id, extra = {}, index = 0) =>
    fetch(hosts[index] + '/api/orders/' + id, {
      headers: Object.fromEntries(
        Object.entries({ Cookie: cookies[index], ...extra }).filter(([, v]) => v !== undefined),
      ),
    });

  const patchOrder = (id, input, extra = {}, index = 0) =>
    fetch(hosts[index] + '/api/orders/' + id, {
      method: 'PATCH',
      headers: Object.fromEntries(
        Object.entries({
          Origin: origin,
          Cookie: cookies[index],
          'Content-Type': 'application/json',
          ...extra,
        }).filter(([, value]) => value !== undefined),
      ),
      body: JSON.stringify(input),
    });
  const storedOrder = async (id) => {
    const response = await readDetail(id);
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };

  const readyOrder = async (changes = {}) => {
    const parcels = (
      changes.parcels ?? [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 1 }]
    ).map((p) => ({ notifiedPrice: 3500, ...p }));
    const response = await create({
      customerSeq: otherId,
      paymentMethodType: 'credit',
      pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
      ...changes,
      parcels,
      totalAmount: changes.totalAmount ?? parcels.reduce((n, p) => n + (p.notifiedPrice ?? 0), 0),
    });
    assert.equal(response.status, 201);
    return (await response.json()).data;
  };
  const submitOrder = (order, extra = {}, index = 0, body = { expectedVersion: order.version }) =>
    fetch(hosts[index] + `/api/orders/${order.orderSeq}/submit`, {
      method: 'POST',
      headers: Object.fromEntries(
        Object.entries({
          Origin: origin,
          Cookie: cookies[index],
          'Content-Type': 'application/json',
          ...extra,
        }).filter(([, value]) => value !== undefined),
      ),
      body: JSON.stringify(body),
    });
  const cancelOrder = (id, parcels, index = 0) =>
    fetch(hosts[index] + `/api/orders/${id}${parcels === undefined ? '' : '/parcels'}/cancel`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookies[index], 'Content-Type': 'application/json' },
      body: parcels === undefined ? undefined : JSON.stringify({ orderParcelSeqs: parcels }),
    });
  const resetDver = () => {
    dverRequests = [];
    dverRespond = (_req, res) => res.end(JSON.stringify(dverSuccess));
  };

  const aiResult = (outcome = 'COMPLETE', changes = {}) => {
    const parcels = (
      changes.parcels ?? [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 1 }]
    ).map((p) => ({ notifiedPrice: 3500, ...p }));
    return {
      outcome,
      call: {
        providerCallId: randomUUID(),
        callerPhoneNumber: '+821000000001',
        incomingAt: '2026-10-27T01:00:00Z',
      },
      customerSeq: customerId,
      paymentMethodType: 'credit',
      pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
      ...changes,
      parcels,
      totalAmount: changes.totalAmount ?? parcels.reduce((n, p) => n + (p.notifiedPrice ?? 0), 0),
    };
  };
  const submissionRows = async (id) =>
    (
      await pool.query(
        `SELECT
  (SELECT status FROM orders WHERE order_seq=$1) AS status,
  (SELECT count(*)::int FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1) AS shipments,
  (SELECT count(*)::int FROM shipment_status_history h JOIN shipments s USING(shipment_seq) JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1) AS history,
  (SELECT count(*)::int FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND action='ORDER_SUBMISSION_ACCEPTED' AND result='SUCCESS') AS "acceptedAudit"`,
        [id],
      )
    ).rows[0];

  async function waitForBlockedBy(pid) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await pool.query(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
        [pid],
      );
      if (rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('Expected a database lock wait');
  }

  const contextCall = () => ({
    providerCallId: randomUUID(),
    incomingAt: new Date().toISOString(),
  });
  const startCallContext = (phoneNumber, call, index = 0, extra = {}) =>
    fetch(hosts[index] + '/api/customers/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...businessHeaders(), ...extra },
      body: JSON.stringify({ phoneNumber, call }),
    });

  const screenOrders = (query = {}, headers = {}, index = 0) =>
    fetch(hosts[index] + '/api/admin/orders?' + new URLSearchParams(query), {
      headers: { Cookie: cookies[index], ...headers },
    });
  return {
    test,
    address,
    call,
    aiCreate,
    get customerId() {
      return customerId;
    },
    set customerId(value) {
      customerId = value;
    },
    assert,
    pool,
    counts,
    errorCode,
    randomUUID,
    get adminId() {
      return adminId;
    },
    set adminId(value) {
      adminId = value;
    },
    apps,
    AuditService,
    create,
    resetDver,
    emptyAiResult,
    get dverRequests() {
      return dverRequests;
    },
    set dverRequests(value) {
      dverRequests = value;
    },
    readDetail,
    ConfigService,
    hosts,
    cookies,
    get repository() {
      return repository;
    },
    set repository(value) {
      repository = value;
    },
    aiResult,
    get personalPin() {
      return personalPin;
    },
    set personalPin(value) {
      personalPin = value;
    },
    DatabaseService,
    get withdrawnId() {
      return withdrawnId;
    },
    set withdrawnId(value) {
      withdrawnId = value;
    },
    get otherPin() {
      return otherPin;
    },
    set otherPin(value) {
      otherPin = value;
    },
    get companyPin() {
      return companyPin;
    },
    set companyPin(value) {
      companyPin = value;
    },
    get organizationId() {
      return organizationId;
    },
    set organizationId(value) {
      organizationId = value;
    },
    readCustomer,
    readOrder,
    readOrders,
    get otherId() {
      return otherId;
    },
    set otherId(value) {
      otherId = value;
    },
    aiReadHeaders,
    testMembership,
    storedOrder,
    patchOrder,
    dverSuccess,
    submissionRows,
    get dverRespond() {
      return dverRespond;
    },
    set dverRespond(value) {
      dverRespond = value;
    },
    readyOrder,
    cancelOrder,
    submitOrder,
    OrderPaymentsService,
    get submissionRepository() {
      return submissionRepository;
    },
    set submissionRepository(value) {
      submissionRepository = value;
    },
    OrdersRepository,
    origin,
    waitForBlockedBy,
    startCallContext,
    contextCall,
    screenOrders,
  };
};
