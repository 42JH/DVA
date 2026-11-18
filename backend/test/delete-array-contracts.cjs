module.exports = function deleteArrayContracts(f) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  const { randomUUID, randomInt } = require('node:crypto');
  const { AuditRepository } = require('../dist/audit/audit.repository');
  const { businessHeaders, createTestSession } = require('./helpers/application.cjs');
  const { seedTestCard } = require('./helpers/payment-cards.cjs');
  const insert = async (sql, values = []) => (await f.pool.query(sql, values)).rows[0].id;
  const customer = () =>
    insert(
      "INSERT INTO customers(name,phone_number,status) VALUES('삭제 계약',$1,'ACTIVE') RETURNING customer_seq AS id",
      ['010' + randomInt(10000000, 100000000)],
    );
  const company = () =>
    insert(
      "INSERT INTO organizations(name,status) VALUES($1,'ACTIVE') RETURNING organization_seq AS id",
      ['삭제 계약 ' + randomUUID()],
    );
  const call = (ended = true) =>
    insert(
      "INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at) VALUES($1,clock_timestamp()-interval '2 minutes',CASE WHEN $2 THEN clock_timestamp()-interval '1 minute' END,CASE WHEN $2 THEN clock_timestamp() END) RETURNING call_session_seq AS id",
      [randomUUID(), ended],
    );
  const admin = () =>
    insert(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'삭제 계약','not-for-login','OPERATOR','ACTIVE') RETURNING admin_user_seq AS id",
      ['bulk' + randomUUID().replaceAll('-', '').slice(0, 15)],
    );
  const order = () =>
    insert(
      "INSERT INTO orders(status,payment_method_type) VALUES('CANCELLED','billing') RETURNING order_seq AS id",
    );
  const draft = () =>
    insert(
      "INSERT INTO order_parcel_drafts(created_by_admin_user_seq,client_parcel_id,creation_payload,parcel_data,status) VALUES($1,$2,'{}','{}','INCOMPLETE') RETURNING draft_seq AS id",
      [f.ids[0], randomUUID()],
    );
  const department = async () =>
    insert(
      'INSERT INTO departments(organization_seq,name) VALUES($1,$2) RETURNING department_seq AS id',
      [await company(), '부서 ' + randomUUID()],
    );
  const member = async () =>
    insert(
      "INSERT INTO memberships(organization_seq,customer_seq,employee_no,status) VALUES($1,$2,$3,'ACTIVE') RETURNING membership_seq AS id",
      [await company(), await customer(), randomUUID()],
    );
  const question = async () =>
    insert(
      "INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,payload_hash) VALUES($1,$2,'삭제 계약',clock_timestamp(),$3) RETURNING unanswered_question_seq AS id",
      [randomUUID(), await call(), 'a'.repeat(64)],
    );
  const cases = [
    ['admins', 'adminUserSeqs', 'admin_users', 'admin_user_seq', admin, 'ADMIN_DELETED'],
    ['calls', 'callSessionSeqs', 'call_sessions', 'call_session_seq', call, 'CALL_DELETED'],
    ['orders', 'orderSeqs', 'orders', 'order_seq', order, 'ORDER_DELETED'],
    [
      'parcel-drafts',
      'draftSeqs',
      'order_parcel_drafts',
      'draft_seq',
      draft,
      'PARCEL_DRAFT_DELETED',
    ],
    [
      'departments',
      'departmentSeqs',
      'departments',
      'department_seq',
      department,
      'DEPARTMENT_DELETED',
    ],
    ['members', 'membershipSeqs', 'memberships', 'membership_seq', member, 'MEMBERSHIP_REMOVED'],
    [
      'unanswered-questions',
      'unansweredQuestionSeqs',
      'unanswered_questions',
      'unanswered_question_seq',
      question,
      'UNANSWERED_QUESTION_DELETED',
    ],
    [
      'customers/cards',
      'customerSeqs',
      'payment_cards',
      'customer_seq',
      async () => {
        const id = await customer();
        await seedTestCard(f.pool, 'CUSTOMER', id);
        return id;
      },
      'PAYMENT_CARD_DELETED',
    ],
    [
      'companies/group-cards',
      'organizationSeqs',
      'payment_cards',
      'organization_seq',
      async () => {
        const id = await company();
        await seedTestCard(f.pool, 'ORGANIZATION', id);
        return id;
      },
      'PAYMENT_CARD_DELETED',
    ],
  ];
  const write = (resource, field, ids, headers = {}) =>
    f.write('DELETE', '/api/' + resource, { [field]: ids }, 2, headers);
  const rows = (table, key, ids) =>
    f.pool
      .query(`SELECT * FROM ${table} WHERE ${key}=ANY($1::int[]) ORDER BY ${key}`, [ids])
      .then((r) => r.rows);
  const noSuccess = async (id) =>
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
          id,
        ])
      ).rowCount,
      0,
    );

  test('every converted DELETE validates arrays and rolls back the entire batch on missing targets or audit failure', async (t) => {
    for (const [resource, field, table, key, seed, action] of cases)
      await t.test(resource, async () => {
        const ids = [await seed(), await seed()],
          before = await rows(table, key, ids);
        for (const invalid of [
          [],
          [ids[0], ids[0]],
          ['1'],
          [0],
          Array.from({ length: 101 }, (_, i) => i + 1),
        ])
          await f.error(await write(resource, field, invalid), 400, 'INVALID_REQUEST');
        await f.error(
          await write(resource, field, ids, { Cookie: undefined }),
          401,
          'UNAUTHORIZED',
        );
        await f.error(await write(resource, field, ids, { Origin: undefined }), 403, 'FORBIDDEN');
        const missing = await write(resource, field, [...ids, 2147483647]);
        await f.error(missing, 404, 'NOT_FOUND');
        assert.deepEqual(await rows(table, key, ids), before);
        await noSuccess(missing.headers.get('x-request-id'));
        const audit = f.app.get(AuditRepository),
          original = audit.insert;
        let count = 0,
          response;
        audit.insert = async function (event, result, client) {
          if (event.action === action && result === 'SUCCESS' && ++count === 2)
            throw Error('test audit failure');
          return original.call(this, event, result, client);
        };
        try {
          response = await write(resource, field, ids);
          await f.error(response, 500, 'INTERNAL_ERROR');
        } finally {
          audit.insert = original;
        }
        assert.deepEqual(await rows(table, key, ids), before);
        await noSuccess(response.headers.get('x-request-id'));
        const done = await write(resource, field, ids.slice().reverse());
        assert.equal(done.status, 204, await done.clone().text());
        assert.equal(await done.text(), '');
        assert.ok((await rows(table, key, ids)).every((row) => row.deleted_at));
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' AND action=$2",
              [done.headers.get('x-request-id'), action],
            )
          ).rowCount,
          2,
        );
        const replay = await write(resource, field, [ids[0]]);
        assert.equal(
          replay.status,
          resource.includes('cards') || resource === 'unanswered-questions' ? 204 : 404,
        );
        const single = await seed();
        assert.equal((await write(resource, field, [single])).status, 204);
        if (resource === 'admins')
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM admin_sessions WHERE admin_user_seq=ANY($1::int[])',
                [ids],
              )
            ).rowCount,
            0,
          );
      });
  });

  test('all DELETE routes expose one array contract with no old single-resource aliases', async () => {
    const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
    const doc = SwaggerModule.createDocument(f.app, new DocumentBuilder().build());
    const deletes = Object.entries(doc.paths).filter(([, v]) => v.delete);
    assert.equal(deletes.length, 14);
    assert.ok(deletes.every(([route]) => !route.includes('{')));
    for (const [resource, field] of cases) {
      const operation = doc.paths['/api/' + resource].delete;
      assert.ok(operation.requestBody.required);
      const model =
        doc.components.schemas[
          operation.requestBody.content['application/json'].schema.$ref.split('/').at(-1)
        ];
      assert.equal(model.properties[field].type, 'array');
      assert.equal(model.properties[field].minItems, 1);
      assert.equal(model.properties[field].maxItems, 100);
      const seed = cases.find((row) => row[0] === resource)[4],
        id = await seed();
      const legacy =
        resource === 'customers/cards'
          ? `/api/customers/${id}/card`
          : resource === 'companies/group-cards'
            ? `/api/companies/${id}/group-card`
            : `/api/${resource}/${id}`;
      await f.error(await f.write('DELETE', legacy), 404, 'NOT_FOUND');
      assert.equal((await write(resource, field, [id])).status, 204);
    }
  });

  test('protected administrators and in-progress calls/orders/drafts still reject and roll back mixed batches', async () => {
    const a = await admin();
    await createTestSession(f.pool, a);
    await f.error(await write('admins', 'adminUserSeqs', [a, f.ids[2]]), 403, 'FORBIDDEN');
    assert.equal((await rows('admin_users', 'admin_user_seq', [a]))[0].deleted_at, null);
    assert.equal(
      (await f.pool.query('SELECT 1 FROM admin_sessions WHERE admin_user_seq=$1', [a])).rowCount,
      1,
    );
    const ended = await call(),
      live = await call(false);
    await f.error(await write('calls', 'callSessionSeqs', [ended, live]), 409, 'INVALID_STATE');
    assert.ok(
      (await rows('call_sessions', 'call_session_seq', [ended, live])).every((r) => !r.deleted_at),
    );
    const cancelled = await order(),
      pending = await order();
    await f.pool.query("UPDATE orders SET status='notPaid' WHERE order_seq=$1", [pending]);
    await f.error(await write('orders', 'orderSeqs', [cancelled, pending]), 409, 'INVALID_STATE');
    assert.ok(
      (await rows('orders', 'order_seq', [cancelled, pending])).every((r) => !r.deleted_at),
    );
    const old = await draft(),
      ready = await draft();
    await f.pool.query(
      "UPDATE order_parcel_drafts SET call_session_seq=$2,status='READY' WHERE draft_seq=$1",
      [ready, live],
    );
    await f.error(await write('parcel-drafts', 'draftSeqs', [old, ready]), 409, 'INVALID_STATE');
    assert.ok(
      (await rows('order_parcel_drafts', 'draft_seq', [old, ready])).every((r) => !r.deleted_at),
    );
    await f.pool.query(
      'UPDATE call_sessions SET started_at=COALESCE(started_at,incoming_at),ended_at=clock_timestamp() WHERE call_session_seq=$1',
      [live],
    );
  });

  test('AI card deletion retains caller scope across a whole batch and never removes another owner card', async () => {
    const a = await customer(),
      b = await customer();
    await seedTestCard(f.pool, 'CUSTOMER', a);
    await seedTestCard(f.pool, 'CUSTOMER', b);
    const c = await call(false),
      phone = (await rows('customers', 'customer_seq', [a]))[0].phone_number;
    await f.pool.query(
      'UPDATE call_sessions SET customer_seq=$2,caller_phone_number=$3 WHERE call_session_seq=$1',
      [c, a, phone],
    );
    const headers = { Cookie: undefined, ...businessHeaders(), call_session_seq: String(c) };
    await f.error(
      await write('customers/cards', 'customerSeqs', [a, b], headers),
      403,
      'FORBIDDEN',
    );
    assert.ok((await rows('payment_cards', 'customer_seq', [a, b])).every((r) => !r.deleted_at));
    const response = await write('customers/cards', 'customerSeqs', [a], headers);
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal((await rows('payment_cards', 'customer_seq', [b]))[0].deleted_at, null);
    const audit = (
      await f.pool.query(
        "SELECT actor_type FROM audit_logs WHERE request_id=$1 AND action='PAYMENT_CARD_DELETED'",
        [response.headers.get('x-request-id')],
      )
    ).rows;
    assert.deepEqual(audit, [{ actor_type: 'AI' }]);
    await f.pool.query(
      'UPDATE call_sessions SET started_at=COALESCE(started_at,incoming_at),ended_at=clock_timestamp() WHERE call_session_seq=$1',
      [c],
    );
  });
};
