module.exports = function registerOrdersConcurrency(suite) {
  const {
    test,
    resetDver,
    apps,
    readCustomer,
    testMembership,
    pool,
    address,
    readyOrder,
    create,
    submitOrder,
    hosts,
    origin,
    cookies,
    waitForBlockedBy,
    assert,
    aiResult,
    randomUUID,
    aiCreate,
    errorCode,
  } = suite;
  for (const operation of ['create', 'update', 'submit']) {
    test(
      'lock ordering lets ' + operation + ' finish before a waiting membership change',
      async () => {
        resetDver();
        const { CustomersRepository } = require('../dist/customers/customers.repository');
        const customers = apps[0].get(CustomersRepository);
        const { customer, phone } = await readCustomer();
        const employeeNo = String(customer);
        const membership = (
          await testMembership(pool, {
            customerSeq: customer,
            organizationSeq: suite.organizationId,
            employeeNo,
          })
        ).rows[0].membership_seq;
        const department = (
          await pool.query('SELECT department_seq FROM memberships WHERE membership_seq=$1', [
            membership,
          ])
        ).rows[0].department_seq;
        const parcel = {
          originPin: { scope: 'COMPANY', pinSeq: suite.companyPin },
          origin: address,
          destination: address,
          smallBoxCount: 1,
          itemPrice: 0,
        };
        const order =
          operation === 'create'
            ? null
            : await readyOrder({
                customerSeq: customer,
                paymentMethodType: 'groupBilling',
                parcels: [parcel],
              });
        const original = customers.find;
        let unlock, reached;
        const gate = new Promise((resolve) => {
          unlock = resolve;
        });
        const locked = new Promise((resolve) => {
          reached = resolve;
        });
        customers.find = async function (id, client) {
          const result = await original.call(this, id, client);
          if (id === customer && client) {
            reached(client.processID);
            await gate;
          }
          return result;
        };
        let pendingOrder, pendingMember;
        try {
          pendingOrder =
            operation === 'create'
              ? create({ customerSeq: customer, parcels: [parcel] })
              : operation === 'submit'
                ? submitOrder(order)
                : fetch(hosts[0] + '/api/orders/' + order.orderSeq, {
                    method: 'PATCH',
                    headers: {
                      Origin: origin,
                      Cookie: cookies[0],
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ expectedVersion: order.version, parcels: [parcel] }),
                  });
          const pid = await locked;
          if (operation === 'update') {
            pendingMember = fetch(
              hosts[1] + '/api/companies/' + suite.organizationId + '/members',
              {
                method: 'POST',
                headers: { Origin: origin, Cookie: cookies[1], 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  items: [
                    {
                      employeeNo,
                      name: '변경 고객',
                      phoneNumber: phone,
                      departmentSeq: department,
                    },
                  ],
                }),
              },
            );
          } else {
            pendingMember = fetch(hosts[1] + '/api/members/' + membership, {
              method: 'PATCH',
              headers: { Origin: origin, Cookie: cookies[1], 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'ACTIVE' }),
            });
          }
          await waitForBlockedBy(pid);
          unlock();
          const [orderResponse, memberResponse] = await Promise.all([pendingOrder, pendingMember]);
          assert.equal(orderResponse.status, operation === 'create' ? 201 : 200);
          assert.equal(memberResponse.status, 204);
          assert.equal(suite.dverRequests.length, operation === 'submit' ? 1 : 0);
          if (operation === 'submit') {
            assert.equal((await submitOrder(order)).status, 200);
            assert.equal(suite.dverRequests.length, 1);
          }
        } finally {
          unlock();
          await Promise.allSettled([pendingOrder, pendingMember]);
          customers.find = original;
        }
      },
    );
  }

  for (const status of ['ACTIVE', 'INACTIVE']) {
    test(
      'lock ordering resumes AI completion using the committed ' + status + ' membership',
      async () => {
        resetDver();
        const { MembersRepository } = require('../dist/members/members.repository');
        const members = apps[1].get(MembersRepository);
        const { customer, phone } = await readCustomer();
        const membership = (
          await testMembership(pool, {
            customerSeq: customer,
            organizationSeq: suite.organizationId,
            employeeNo: String(customer),
          })
        ).rows[0].membership_seq;
        const original = members.update;
        let unlock, reached;
        const gate = new Promise((resolve) => {
          unlock = resolve;
        });
        const locked = new Promise((resolve) => {
          reached = resolve;
        });
        members.update = async function (id, input, client) {
          if (id === membership) {
            reached(client.processID);
            await gate;
          }
          return original.call(this, id, input, client);
        };
        const input = aiResult('COMPLETE', {
          customerSeq: customer,
          call: {
            providerCallId: randomUUID(),
            incomingAt: new Date().toISOString(),
            callerPhoneNumber: phone,
          },
          paymentMethodType: 'groupBilling',
          parcels: [
            {
              originPin: { scope: 'COMPANY', pinSeq: suite.companyPin },
              origin: address,
              destination: address,
              smallBoxCount: 1,
              itemPrice: 0,
            },
          ],
        });
        const key = randomUUID();
        let pendingOrder, pendingMember;
        try {
          pendingMember = fetch(hosts[1] + '/api/members/' + membership, {
            method: 'PATCH',
            headers: { Origin: origin, Cookie: cookies[1], 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          });
          const pid = await locked;
          pendingOrder = aiCreate(undefined, input, key);
          await waitForBlockedBy(pid);
          assert.equal(suite.dverRequests.length, 0);
          unlock();
          const [orderResponse, memberResponse] = await Promise.all([pendingOrder, pendingMember]);
          assert.equal(memberResponse.status, 204);
          if (status === 'ACTIVE') {
            assert.equal(orderResponse.status, 201);
            assert.equal((await orderResponse.json()).data.status, 'ACCEPTED');
            assert.equal((await aiCreate(undefined, input, key, 1)).status, 201);
            assert.equal(suite.dverRequests.length, 1);
          } else {
            await errorCode(orderResponse, 403, 'FORBIDDEN');
            assert.equal(suite.dverRequests.length, 0);
            assert.equal(
              (await pool.query('SELECT 1 FROM orders WHERE creation_request_id=$1', [key]))
                .rowCount,
              0,
            );
          }
        } finally {
          unlock();
          await Promise.allSettled([pendingOrder, pendingMember]);
          members.update = original;
        }
      },
    );
  }
  test('lock ordering times out without partial writes or Dver calls and permits a later retry', async () => {
    resetDver();
    const { customer, phone } = await readCustomer();
    const input = aiResult('COMPLETE', {
      customerSeq: customer,
      call: {
        providerCallId: randomUUID(),
        incomingAt: new Date().toISOString(),
        callerPhoneNumber: phone,
      },
    });
    const key = randomUUID();
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT customer_seq FROM customers WHERE customer_seq=$1 FOR UPDATE', [
        customer,
      ]);
      const started = Date.now();
      await errorCode(await aiCreate(undefined, input, key), 409, 'REQUEST_IN_PROGRESS');
      assert.ok(Date.now() - started >= 1500);
      assert.equal(suite.dverRequests.length, 0);
      assert.equal(
        (await pool.query('SELECT 1 FROM orders WHERE creation_request_id=$1', [key])).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
            input.call.providerCallId,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    assert.equal((await aiCreate(undefined, input, key)).status, 201);
    assert.equal(suite.dverRequests.length, 1);
  });
};
