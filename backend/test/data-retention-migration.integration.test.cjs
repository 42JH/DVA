const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { once } = require('node:events');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const connection = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};

test('045 rolls back atomically and upgrades populated 044 without losing timestamps, versions, FKs or snapshots', async () => {
  const name = 'dva_retention_' + randomUUID().replaceAll('-', '');
  assert.match(name, /^dva_retention_[a-f0-9]{32}$/);
  const owner = new Pool({ ...connection, database: process.env.DB_NAME });
  let probe;
  try {
    await owner.query(`CREATE DATABASE ${name}`);
    probe = new Pool({ ...connection, database: name });
    const directory = join(__dirname, '../migrations');
    const client = await probe.connect();
    try {
      await client.query('BEGIN');
      for (const file of readdirSync(directory)
        .filter((file) => /^\d{3}-.+\.sql$/.test(file) && file < '045-')
        .sort())
        await client.query(readFileSync(join(directory, file), 'utf8'));
      await client.query('COMMIT');
      await client.query(`INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('migration157','현재 작성자','test-only','OPERATOR','ACTIVE');
        INSERT INTO customers(name,phone_number,status) VALUES('과거 고객','01000157000','ACTIVE');
        INSERT INTO organizations(name,status) VALUES('과거 기업','ACTIVE');
        INSERT INTO departments(organization_seq,name) VALUES(1,'과거 부서');
        INSERT INTO memberships(customer_seq,organization_seq,employee_no,status,department_seq) VALUES(1,1,'EMP157','ACTIVE',1);
        INSERT INTO orders(customer_seq,status,version,created_at,updated_at) VALUES(1,'CANCELLED',7,'2020-01-01T00:00:00Z','2021-01-01T00:00:00Z');
        INSERT INTO orders(status) VALUES('COLLECTING');
        INSERT INTO call_sessions(provider_call_id,started_at,ended_at) VALUES('legacy157','2020-01-02T00:00:00Z','2020-01-02T00:01:00Z');
        INSERT INTO call_sessions(provider_call_id) VALUES('unknown157');
        INSERT INTO ai_personas(code) VALUES('migration157');
        INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level,created_by_admin_user_seq)
          VALUES(1,1,'과거 페르소나','원본 프롬프트','NORMAL',1);
        INSERT INTO audit_logs(actor_type,actor_seq,action,target_type,target_seq,request_id,result,metadata,actor_name)
          VALUES('ADMIN',1,'ORDER_CREATED','ORDER',1,gen_random_uuid(),'SUCCESS','{}','과거 작성자'),
           ('ADMIN',1,'PERSONA_CREATED','AI_PERSONA_VERSION',1,gen_random_uuid(),'SUCCESS','{}','과거 작성자');
        INSERT INTO unanswered_questions(event_id,call_session_seq,status,payload_hash,deleted_at,occurred_at)
          VALUES(gen_random_uuid(),1,'DELETED',repeat('a',64),clock_timestamp(),clock_timestamp())`);
      const before = (
        await client.query('SELECT version,created_at,updated_at FROM orders WHERE order_seq=1')
      ).rows[0];
      const sql = readFileSync(join(directory, '045-data-retention.sql'), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await assert.rejects(client.query('SELECT 1/0'), { code: '22012' });
      await client.query('ROLLBACK');
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='deleted_at'",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM pg_constraint WHERE conname='memberships_customer_seq_key'",
          )
        ).rowCount,
        1,
      );
      assert.deepEqual(
        (await client.query('SELECT version,created_at,updated_at FROM orders WHERE order_seq=1'))
          .rows[0],
        before,
      );
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      const upgraded = (
        await client.query(
          'SELECT version,created_at,updated_at,closed_at,created_by_admin_user_seq FROM orders WHERE order_seq=1',
        )
      ).rows[0];
      const { closed_at, created_by_admin_user_seq, ...unchanged } = upgraded;
      assert.deepEqual(unchanged, before);
      assert.deepEqual(closed_at, before.created_at);
      assert.equal(created_by_admin_user_seq, 1);
      assert.equal(
        (await client.query('SELECT created_by_admin_user_seq FROM orders WHERE order_seq=2'))
          .rows[0].created_by_admin_user_seq,
        null,
      );
      assert.equal(
        (await client.query('SELECT created_by_admin_user_name FROM ai_persona_versions')).rows[0]
          .created_by_admin_user_name,
        '과거 작성자',
      );
      const calls = (
        await client.query(
          'SELECT incoming_at,started_at FROM call_sessions ORDER BY call_session_seq',
        )
      ).rows;
      assert.deepEqual(calls[0].incoming_at, calls[0].started_at);
      assert.equal(calls[1].incoming_at, null);
      assert.equal(
        (await client.query('SELECT question_text FROM unanswered_questions')).rows[0]
          .question_text,
        null,
      );
      await client.query(
        "INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,payload_hash) VALUES(gen_random_uuid(),1,'보존 원문',clock_timestamp(),repeat('b',64))",
      );
      await client.query(
        "UPDATE unanswered_questions SET status='DELETED',deleted_at=clock_timestamp() WHERE question_text='보존 원문'",
      );
      assert.equal(
        (
          await client.query(
            "SELECT question_text FROM unanswered_questions WHERE question_text='보존 원문'",
          )
        ).rowCount,
        1,
      );
      await client.query(
        'UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=1',
      );
      await client.query(
        "INSERT INTO memberships(customer_seq,organization_seq,employee_no,status,department_seq) VALUES(1,1,'EMP157','ACTIVE',1)",
      );
      assert.equal((await client.query('SELECT count(*)::int AS n FROM memberships')).rows[0].n, 2);
      await assert.rejects(
        client.query(
          "INSERT INTO memberships(customer_seq,organization_seq,employee_no,status,department_seq) VALUES(1,1,'EMP157','ACTIVE',1)",
        ),
        { code: '23505' },
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace s ON s.oid=c.connamespace WHERE s.nspname='public' AND c.contype='f'",
          )
        ).rows[0].n,
        25,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND NOT t.tgisinternal",
          )
        ).rows[0].n,
        10,
      );
      await client.query('LISTEN faq_changed');
      let notice = once(client, 'notification', { signal: AbortSignal.timeout(2000) });
      const faq = (
        await client.query(
          "INSERT INTO faq_entries(question,answer,category,updated_by_admin_user_seq) VALUES('보관 정책 알림','답변','기타',1) RETURNING faq_entry_seq",
        )
      ).rows[0].faq_entry_seq;
      assert.equal(JSON.parse((await notice)[0].payload).operation, 'INSERT');
      notice = once(client, 'notification', { signal: AbortSignal.timeout(2000) });
      await client.query(
        'UPDATE faq_entries SET deleted_at=clock_timestamp() WHERE faq_entry_seq=$1',
        [faq],
      );
      assert.equal(JSON.parse((await notice)[0].payload).operation, 'DELETE');
      const notifications = [];
      const collect = (message) => notifications.push(JSON.parse(message.payload));
      client.on('notification', collect);
      await client.query('DELETE FROM faq_entries WHERE faq_entry_seq=$1', [faq]);
      const sentinel = new Promise((resolve) => {
        const listen = (message) => {
          if (JSON.parse(message.payload).sentinel) {
            client.off('notification', listen);
            resolve();
          }
        };
        client.on('notification', listen);
      });
      await client.query("SELECT pg_notify('faq_changed','{\"sentinel\":true}')");
      await sentinel;
      client.off('notification', collect);
      assert.deepEqual(notifications, [{ sentinel: true }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await probe?.end();
    await owner.query(`DROP DATABASE IF EXISTS ${name}`);
    await owner.end();
  }
});
