const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { hashPassword } = require('../dist/auth/password');

test('production smoke prepares accounts, an active persona and an accepted address snapshot independently', async () => {
  const pool = createTestPool();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const accounts = await client.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status)
       VALUES('runtimeAdmin83','Runtime test',$1,'OPERATOR','ACTIVE'),
       ('runtimeSearchAdmin83','Runtime search admin',$1,'SYSTEM_ADMIN','ACTIVE')
       RETURNING role,admin_user_seq`,
      [await hashPassword('runtime-only-password')],
    );
    assert.deepEqual(accounts.rows.map((row) => row.role).sort(), ['OPERATOR', 'SYSTEM_ADMIN']);
    if (
      !(
        await client.query(
          "SELECT 1 FROM ai_persona_versions v JOIN ai_personas p USING(ai_persona_seq) WHERE v.status='ACTIVE'",
        )
      ).rowCount
    ) {
      const persona = (
        await client.query('INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq', [
          'runtime-' + randomUUID(),
        ])
      ).rows[0].ai_persona_seq;
      const version = await client.query(
        `INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level,
         status,application_id,requested_by_admin_user_seq,requested_at,applied_at)
         VALUES($1,1,'Runtime persona','Runtime prompt','NORMAL','ACTIVE',$2,$3,clock_timestamp(),clock_timestamp())
         RETURNING status`,
        [persona, randomUUID(), accounts.rows[0].admin_user_seq],
      );
      assert.equal(version.rows[0].status, 'ACTIVE');
    }
    const customer = (
      await client.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('Runtime history',$1,'ACTIVE') RETURNING customer_seq",
        ['010' + randomInt(10000000, 100000000)],
      )
    ).rows[0].customer_seq;
    const order = (
      await client.query(
        "INSERT INTO orders(customer_seq,payment_method_type,pickup_requested_at,total_amount) VALUES($1,'billing',clock_timestamp()+interval '1 day',3500) RETURNING order_seq",
        [customer],
      )
    ).rows[0].order_seq;
    await client.query(
      `INSERT INTO order_parcels(order_seq,parcel_position,
       origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_detail_address,origin_dong_name,origin_postal_code,
       destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_detail_address,destination_dong_name,destination_postal_code,
       small_box_count,item_price,notified_price)
       VALUES($1,1,'Runtime sender','01000000001','Smoke road 1','Smoke lot 1','','Smoke','01234',
       'Runtime recipient','01000000002','Smoke road 2','Smoke lot 2','101','Smoke','01235',1,10000,3500)`,
      [order],
    );
    await client.query(
      "UPDATE orders SET status='ACCEPTED',parcel_no=$2,dver_received_at=clock_timestamp() WHERE order_seq=$1",
      [order, randomUUID().replaceAll('-', '').slice(0, 8)],
    );
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
});
