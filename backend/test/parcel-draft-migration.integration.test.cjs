const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createTestPool } = require('./helpers/application.cjs');

test('055 atomically copies partial orders, preserves source records and keeps snapshots independent of every logical parent', async () => {
  const owner = createTestPool();
  const name = 'dva_drafts_' + randomUUID().replaceAll('-', '');
  let probe;
  try {
    await owner.query(`CREATE DATABASE ${name}`);
    probe = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: name,
    });
    const client = await probe.connect();
    try {
      const directory = join(__dirname, '../migrations');
      for (const file of readdirSync(directory)
        .filter((p) => /^\d{3}-.+\.sql$/.test(p) && p < '055-')
        .sort())
        await client.query(readFileSync(join(directory, file), 'utf8'));
      const customer = (
        await client.query(
          "INSERT INTO customers(name,phone_number,status) VALUES('이관 고객','01011112222','ACTIVE') RETURNING customer_seq",
        )
      ).rows[0].customer_seq;
      const order = (
        await client.query(
          "INSERT INTO orders(customer_seq,status) VALUES($1,'COLLECTING') RETURNING order_seq",
          [customer],
        )
      ).rows[0].order_seq;
      await client.query(
        "INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_road_address,item_price,notified_price) VALUES($1,1,'보존 발송인','보존 주소',10000,3500),($1,2,'취소 발송인','취소 주소',20000,4000)",
        [order],
      );
      await client.query(
        "UPDATE order_parcels SET status='CANCELLED' WHERE order_seq=$1 AND parcel_position=2",
        [order],
      );
      const call = (
        await client.query(
          "INSERT INTO call_sessions(provider_call_id,customer_seq,caller_phone_number,order_seq,incoming_at) VALUES($1,$2,'01011112222',$3,clock_timestamp()) RETURNING call_session_seq",
          [randomUUID(), customer, order],
        )
      ).rows[0].call_session_seq;
      const empty = (
        await client.query("INSERT INTO orders(status) VALUES('COLLECTING') RETURNING order_seq")
      ).rows[0].order_seq;
      await client.query("INSERT INTO orders(status) VALUES('CANCELLED')");
      const snapshot = async () =>
        (
          await client.query(
            "SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) FROM orders o),'parcels',(SELECT jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq) FROM order_parcels p),'calls',(SELECT jsonb_agg(to_jsonb(c)-ARRAY['order_intake_enabled','order_intake_version','order_completion_received_at','order_completion_payload','order_finalized_at','order_finalization_result','order_finalization_error_code','order_finalization_attempted_at'] ORDER BY call_session_seq) FROM call_sessions c)) AS data",
          )
        ).rows[0].data;
      const before = await snapshot();
      const sql = readFileSync(join(directory, '055-parcel-draft-intake.sql'), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await assert.rejects(client.query('SELECT 1/0'), { code: '22012' });
      await client.query('ROLLBACK');
      assert.equal(
        (await client.query("SELECT to_regclass('order_parcel_drafts') AS name")).rows[0].name,
        null,
      );
      assert.deepEqual(await snapshot(), before);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      assert.deepEqual(await snapshot(), before);
      const drafts = (await client.query('SELECT * FROM order_parcel_drafts ORDER BY draft_seq'))
        .rows;
      assert.equal(drafts.length, 3);
      assert.deepEqual(
        drafts.filter((d) => d.legacy_order_seq === order).map((d) => d.status),
        ['INCOMPLETE', 'CANCELLED'],
      );
      assert.equal(drafts[0].parcel_data.origin.roadAddress, '보존 주소');
      assert.equal(drafts[0].parcel_data.itemPrice, 10000);
      assert.equal(drafts[0].call_session_seq, call);
      assert.equal(
        drafts[0].retention_started_at.toISOString(),
        new Date(before.orders[0].created_at).toISOString(),
      );
      assert.equal(drafts.find((d) => d.legacy_order_seq === empty).parcel_data.origin.name, null);
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM order_payment_requests')).rows[0].n,
        0,
      );
      assert.equal(
        (
          await client.query(
            'SELECT order_intake_enabled FROM call_sessions WHERE call_session_seq=$1',
            [call],
          )
        ).rows[0].order_intake_enabled,
        false,
      );
      const newCall = (
        await client.query(
          'INSERT INTO call_sessions(provider_call_id) VALUES($1) RETURNING call_session_seq,order_intake_enabled',
          [randomUUID()],
        )
      ).rows[0];
      assert.equal(newCall.order_intake_enabled, true);
      await client.query('BEGIN');
      await assert.rejects(
        client.query(
          'UPDATE call_sessions SET order_finalized_at=clock_timestamp() WHERE call_session_seq=$1',
          [newCall.call_session_seq],
        ),
        { code: '23514' },
      );
      await client.query('ROLLBACK');

      const orphanCustomer = (
        await client.query(
          "INSERT INTO customers(name,phone_number,status) VALUES('독립 고객','01022223333','ACTIVE') RETURNING customer_seq",
        )
      ).rows[0].customer_seq;
      const independent = async (values = {}) =>
        (
          await client.query(
            "INSERT INTO order_parcel_drafts(call_session_seq,customer_seq,client_parcel_id,creation_payload,parcel_data,status,source_draft_seq,order_parcel_seq) VALUES($1,$2,$3,'{}',$4,$5,$6,$7) RETURNING draft_seq",
            [
              newCall.call_session_seq,
              orphanCustomer,
              randomUUID(),
              { origin: { roadAddress: '독립 주소' } },
              values.status ?? 'INCOMPLETE',
              values.source ?? null,
              values.parcel ?? null,
            ],
          )
        ).rows[0].draft_seq;
      const source = await independent();
      const child = await independent({ source });
      await assert.rejects(independent({ source }), { code: '23505' });
      const actual = (
        await client.query("INSERT INTO orders(status) VALUES('COLLECTING') RETURNING order_seq")
      ).rows[0].order_seq;
      const parcel = (
        await client.query(
          'INSERT INTO order_parcels(order_seq,parcel_position) VALUES($1,1) RETURNING order_parcel_seq',
          [actual],
        )
      ).rows[0].order_parcel_seq;
      const converted = await independent({ status: 'CONVERTED', parcel });
      await client.query('DELETE FROM order_parcels WHERE order_parcel_seq=$1', [parcel]);
      await client.query('DELETE FROM orders WHERE order_seq=$1', [actual]);
      await client.query('DELETE FROM customers WHERE customer_seq=$1', [orphanCustomer]);
      await client.query('DELETE FROM call_sessions WHERE call_session_seq=$1', [
        newCall.call_session_seq,
      ]);
      await client.query('DELETE FROM order_parcel_drafts WHERE draft_seq=$1', [source]);
      const remaining = (
        await client.query(
          'SELECT * FROM order_parcel_drafts WHERE draft_seq=ANY($1::int[]) ORDER BY draft_seq',
          [[child, converted]],
        )
      ).rows;
      assert.equal(remaining.length, 2);
      assert.equal(remaining[0].source_draft_seq, source);
      assert.equal(remaining[1].order_parcel_seq, parcel);
      assert.ok(
        remaining.every(
          (d) =>
            d.customer_seq === orphanCustomer &&
            d.call_session_seq === newCall.call_session_seq &&
            d.parcel_data.origin.roadAddress === '독립 주소',
        ),
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await probe?.end();
    await owner.query("SET statement_timeout='10s'");
    await owner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await owner.end();
  }
});
