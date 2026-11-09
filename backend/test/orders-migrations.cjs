function paymentMethod(suite) {
  const { test, pool, assert } = suite;
  test('migration 037 preserves legacy choices and only permits undecided drafts or cancellations', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "CREATE TEMP TABLE orders(order_seq integer GENERATED ALWAYS AS IDENTITY, payment_method_type text NOT NULL DEFAULT 'billing', status text NOT NULL DEFAULT 'COLLECTING')",
      );
      await client.query(
        "INSERT INTO orders(payment_method_type) VALUES('billing'),('credit'),('groupBilling'),('cat')",
      );
      const before = (await client.query('SELECT * FROM orders ORDER BY order_seq')).rows;
      await client.query(
        readFileSync(
          join(__dirname, '../migrations/037-undecided-order-payment-method.sql'),
          'utf8',
        ),
      );
      assert.deepEqual(
        (await client.query('SELECT * FROM orders ORDER BY order_seq')).rows,
        before,
      );
      const created = (
        await client.query('INSERT INTO orders DEFAULT VALUES RETURNING payment_method_type')
      ).rows[0];
      assert.equal(created.payment_method_type, null);
      await client.query("INSERT INTO orders(status) VALUES('CANCELLED')");
      for (const status of ['notPaid', 'PAID', 'SUBMITTING', 'ACCEPTED', 'SUBMISSION_FAILED']) {
        await client.query('SAVEPOINT payment_check');
        await assert.rejects(client.query('INSERT INTO orders(status) VALUES($1)', [status]), {
          code: '23514',
          constraint: 'orders_payment_method_required_check',
        });
        await client.query('ROLLBACK TO SAVEPOINT payment_check');
      }
      assert.equal(
        (
          await client.query(
            "SELECT attnotnull FROM pg_attribute WHERE attrelid='pg_temp.orders'::regclass AND attname='payment_method_type'",
          )
        ).rows[0].attnotnull,
        false,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const order = (
      await pool.query(
        'INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq,payment_method_type',
        [suite.customerId],
      )
    ).rows[0];
    assert.equal(order.payment_method_type, null);
    await assert.rejects(
      pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.order_seq]),
      { code: '23514', constraint: 'orders_payment_method_required_check' },
    );
  });
}

module.exports = { paymentMethod };
