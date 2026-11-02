const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const options = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};
const database = 'dva_coordinates_' + randomBytes(6).toString('hex');
const admin = new Pool({ ...options, database: process.env.DB_NAME });
const pool = new Pool({ ...options, database });
const directory = join(__dirname, '../migrations');
const conversion = readFileSync(join(directory, '043-remove-address-coordinates.sql'), 'utf8');
const address = {
  roadAddress: 'Road 1',
  jibunAddress: 'Lot 1',
  detailAddress: '',
  dongName: 'Dong',
  postalCode: '01234',
  latitude: 0,
  longitude: 127,
};
const recipient = { ...address, name: 'Recipient', phoneNumber: '01012345678' };
let created = false;

async function snapshot() {
  const result = {};
  for (const table of ['customers', 'personal_pins', 'company_pins', 'orders', 'order_parcels'])
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${table.slice(0, -1)}_seq`,
      )
    ).rows.map((row) => row.row);
  return result;
}

before(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  created = true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of readdirSync(directory)
      .filter((name) => /^\d{3}-.+\.sql$/.test(name) && name < '043-')
      .sort())
      await client.query(readFileSync(join(directory, file), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    "INSERT INTO customers(name,phone_number,status,address_data) VALUES('Customer','01012345678','ACTIVE',$1),('Unset','01087654321','ACTIVE',NULL)",
    [address],
  );
  await pool.query("INSERT INTO organizations(name,status) VALUES('Company','ACTIVE')");
  await pool.query(
    "INSERT INTO personal_pins(customer_seq,label,address_data,version) VALUES(1,'Home',$1,4)",
    [recipient],
  );
  await pool.query(
    "INSERT INTO company_pins(organization_seq,label,address_data,version) VALUES(1,'Office',$1,6)",
    [recipient],
  );
  for (const status of ['COLLECTING', 'ACCEPTED', 'CANCELLED']) {
    const id = (
      await pool.query(
        "INSERT INTO orders(customer_seq,payment_method_type,total_amount) VALUES(1,'billing',3500) RETURNING order_seq",
      )
    ).rows[0].order_seq;
    await pool.query(
      "INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_latitude,origin_longitude,destination_latitude,destination_longitude,notified_price) VALUES($1,1,'Preserved',0,127,37.5,0,3500)",
      [id],
    );
    if (status === 'ACCEPTED')
      await pool.query(
        "UPDATE orders SET status='ACCEPTED',pickup_requested_at='2026-11-03T00:00:00Z',paid_at='2026-11-02T00:00:00Z',parcel_no='TEST0043',dver_received_at='2026-11-02T00:00:00Z' WHERE order_seq=$1",
        [id],
      );
    if (status === 'CANCELLED')
      await pool.query("UPDATE orders SET status='CANCELLED',total_amount=0 WHERE order_seq=$1", [
        id,
      ]);
  }
});

after(async () => {
  await pool.end();
  try {
    if (created) await admin.query(`DROP DATABASE ${database}`);
  } finally {
    await admin.end();
  }
});

test('failed coordinate conversion restores JSON, columns, validators and PIN guards atomically', async () => {
  const before = await snapshot();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(conversion + '\nSELECT 1/0;'), { code: '22012' });
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (await pool.query('SELECT valid_customer_address($1) AS valid', [address])).rows[0].valid,
    true,
  );
  assert.equal(
    (
      await pool.query('SELECT valid_customer_address($1) AS valid', [
        Object.fromEntries(
          Object.entries(address).filter(([key]) => !['latitude', 'longitude'].includes(key)),
        ),
      ])
    ).rows[0].valid,
    false,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM pg_trigger WHERE tgname IN ('personal_pin_update_guard','company_pin_update_guard') AND tgenabled='O'",
      )
    ).rows[0].count,
    2,
  );
});

test('coordinate conversion removes only retired fields and restores strict address and PIN protections', async () => {
  const expected = await snapshot();
  for (const table of ['customers', 'personal_pins', 'company_pins'])
    for (const row of expected[table])
      if (row.address_data) {
        delete row.address_data.latitude;
        delete row.address_data.longitude;
      }
  for (const row of expected.order_parcels)
    for (const field of [
      'origin_latitude',
      'origin_longitude',
      'destination_latitude',
      'destination_longitude',
    ])
      delete row[field];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(conversion);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  assert.deepEqual(await snapshot(), expected);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND column_name ~ '(latitude|longitude)'",
      )
    ).rows[0].count,
    0,
  );
  const cleanAddress = { ...address };
  delete cleanAddress.latitude;
  delete cleanAddress.longitude;
  const cleanRecipient = {
    ...cleanAddress,
    name: recipient.name,
    phoneNumber: recipient.phoneNumber,
  };
  for (const [validator, valid] of [
    ['valid_customer_address', cleanAddress],
    ['valid_parcel_address', cleanRecipient],
  ]) {
    assert.equal(
      (await pool.query(`SELECT ${validator}($1) AS valid`, [valid])).rows[0].valid,
      true,
    );
    for (const invalid of [
      { ...valid, latitude: 0 },
      { ...valid, longitude: null },
      { ...valid, dongName: '' },
      { ...valid, detailAddress: null },
      { ...valid, unknown: true },
    ])
      assert.equal(
        (await pool.query(`SELECT ${validator}($1) AS valid`, [invalid])).rows[0].valid,
        false,
      );
  }
  await assert.rejects(
    pool.query('UPDATE customers SET address_data=$1 WHERE customer_seq=1', [address]),
    { code: '23514' },
  );
  for (const table of ['personal_pins', 'company_pins']) {
    await assert.rejects(pool.query(`UPDATE ${table} SET address_data=$1`, [recipient]), {
      code: '23514',
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO ${table}(${table === 'personal_pins' ? 'customer_seq' : 'organization_seq'},address_data) VALUES(1,$1)`,
        [cleanRecipient],
      ),
      { code: '23505' },
    );
    const version = expected[table][0].version;
    assert.equal(
      (await pool.query(`UPDATE ${table} SET label='Changed' RETURNING version`)).rows[0].version,
      version + 1,
    );
  }
  await assert.rejects(pool.query('UPDATE personal_pins SET customer_seq=2'), { code: '23514' });
  for (const id of [2, 3])
    await assert.rejects(
      pool.query("UPDATE order_parcels SET origin_name='Forbidden' WHERE order_seq=$1", [id]),
      { code: '23514' },
    );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid IN ('customers'::regclass,'personal_pins'::regclass,'company_pins'::regclass) AND NOT convalidated",
      )
    ).rows[0].count,
    0,
  );
});
