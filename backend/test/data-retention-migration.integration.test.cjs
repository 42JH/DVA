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

test('047 removes legacy schema atomically and preserves addresses, call times, AI handoff flags, FKs and triggers', async () => {
  const name = 'dva_unused_' + randomUUID().replaceAll('-', '');
  assert.match(name, /^dva_unused_[a-f0-9]{32}$/);
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
        .filter((file) => /^\d{3}-.+\.sql$/.test(file) && file < '047-')
        .sort())
        await client.query(readFileSync(join(directory, file), 'utf8'));
      const address = {
        name: '보존 수령인',
        phoneNumber: '01012345678',
        roadAddress: '보존 도로',
        jibunAddress: '보존 지번',
        detailAddress: '101호',
        dongName: '보존동',
        postalCode: '01234',
      };
      const customer = (
        await client.query(
          "INSERT INTO customers(name,phone_number,status) VALUES('보존 고객','01012345678','ACTIVE') RETURNING customer_seq",
        )
      ).rows[0].customer_seq;
      const company = (
        await client.query(
          "INSERT INTO organizations(name,status) VALUES('보존 기업','ACTIVE') RETURNING organization_seq",
        )
      ).rows[0].organization_seq;
      await client.query(
        'INSERT INTO personal_pins(customer_seq,label,address_data) VALUES($1,$2,$3)',
        [customer, '개인 검색 보존', address],
      );
      await client.query(
        'INSERT INTO company_pins(organization_seq,label,address_data) VALUES($1,$2,$3)',
        [company, '기업 주소 보존', address],
      );
      const call = (
        await client.query(
          "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at,end_reason) VALUES('legacy-call','01012345678',statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '1 minute','PBX_ENDED') RETURNING call_session_seq",
        )
      ).rows[0].call_session_seq;
      await client.query(
        "INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,complaints,has_handoff_request,payload_hash) VALUES($1,statement_timestamp(),statement_timestamp()+interval '1 minute','[]',true,repeat('a',64))",
        [call],
      );
      await client.query(
        "INSERT INTO handoff_requests(call_session_seq,reason,status,requested_at) VALUES($1,'기존 요청','REQUESTED',statement_timestamp())",
        [call],
      );
      await client.query('COMMIT');
      const snapshot = async () => ({
        company: (await client.query("SELECT to_jsonb(p)-'search_text' AS row FROM company_pins p"))
          .rows,
        personal: (await client.query('SELECT * FROM personal_pins')).rows,
        calls: (await client.query("SELECT to_jsonb(c)-'end_reason' AS row FROM call_sessions c"))
          .rows,
        analyses: (await client.query('SELECT * FROM call_analyses')).rows,
        foreignKeys: (
          await client.query(
            "SELECT conrelid::regclass::text,conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND conrelid::regclass::text<>'handoff_requests' ORDER BY conname",
          )
        ).rows,
        triggers: (
          await client.query(
            "SELECT tgname,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY tgname",
          )
        ).rows,
      });
      const before = await snapshot();
      const sql = readFileSync(join(directory, '047-remove-unused-schema.sql'), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await assert.rejects(client.query('SELECT 1/0'), { code: '22012' });
      await client.query('ROLLBACK');
      assert.ok((await client.query('SELECT search_text FROM company_pins')).rows[0].search_text);
      assert.equal(
        (await client.query('SELECT end_reason FROM call_sessions')).rows[0].end_reason,
        'PBX_ENDED',
      );
      assert.equal(
        (await client.query('SELECT reason FROM handoff_requests')).rows[0].reason,
        '기존 요청',
      );
      assert.deepEqual(await snapshot(), before);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      assert.equal(
        (await client.query("SELECT to_regclass('public.handoff_requests') AS name")).rows[0].name,
        null,
      );
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='end_reason'",
          )
        ).rowCount,
        0,
      );
      assert.equal(before.foreignKeys.length, 24);
      assert.equal(before.triggers.length, 10);
      for (const change of [
        "ended_at=started_at-interval '1 second'",
        'started_at=NULL',
        'ended_at=NULL',
      ])
        await assert.rejects(
          client.query(`UPDATE call_sessions SET ${change} WHERE call_session_seq=$1`, [call]),
          { code: '23514' },
        );
      assert.deepEqual(await snapshot(), before);
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='company_pins' AND column_name='search_text'",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM personal_pins WHERE strpos(search_text,'개인 검색 보존')>0 AND address_data=$1::jsonb",
            [address],
          )
        ).rowCount,
        1,
      );
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

test('046 upgrades populated 045 atomically without extending old retries or changing order timestamps', async () => {
  const name = 'dva_retry_' + randomUUID().replaceAll('-', '');
  const owner = new Pool({ ...connection, database: process.env.DB_NAME });
  let probe;
  try {
    await owner.query(`CREATE DATABASE ${name}`);
    probe = new Pool({ ...connection, database: name });
    const directory = join(__dirname, '../migrations');
    const setup = await probe.connect();
    try {
      await setup.query('BEGIN');
      for (const file of readdirSync(directory)
        .filter((file) => /^\d{3}-.+\.sql$/.test(file) && file < '046-')
        .sort())
        await setup.query(readFileSync(join(directory, file), 'utf8'));
      await setup.query('COMMIT');
    } finally {
      await setup.query('ROLLBACK');
      setup.release();
    }
    const ids = (
      await probe.query(`INSERT INTO orders(status,payment_method_type,pickup_requested_at,created_at,updated_at,paid_at,version)
       VALUES('SUBMISSION_FAILED','credit',statement_timestamp(),statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 second',statement_timestamp()-interval '2 minutes',7),
        ('SUBMISSION_FAILED','credit',statement_timestamp(),statement_timestamp()-interval '2 hours',statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 hour',8),
        ('SUBMITTING','credit',statement_timestamp(),statement_timestamp()-interval '2 hours',statement_timestamp()-interval '2 seconds',statement_timestamp()-interval '2 minutes',9),
        ('PAID','credit',statement_timestamp(),statement_timestamp(),statement_timestamp(),statement_timestamp(),10)
       RETURNING order_seq`)
    ).rows.map((row) => row.order_seq);
    const before = (
      await probe.query(
        'SELECT order_seq,version,created_at,updated_at,paid_at FROM orders ORDER BY order_seq',
      )
    ).rows;
    const client = await probe.connect();
    try {
      const sql = readFileSync(join(directory, '046-order-submission-retry-window.sql'), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await assert.rejects(client.query('SELECT 1/0'), { code: '22012' });
      await client.query('ROLLBACK');
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='submission_first_attempt_at'",
          )
        ).rowCount,
        0,
      );
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      assert.deepEqual(
        (
          await client.query(
            'SELECT order_seq,version,created_at,updated_at,paid_at FROM orders ORDER BY order_seq',
          )
        ).rows,
        before,
      );
      const rows = (
        await client.query(
          'SELECT status,submission_first_attempt_at,submission_last_attempt_at FROM orders ORDER BY order_seq',
        )
      ).rows;
      assert.deepEqual(
        rows.map((row) => row.status),
        ['SUBMITTING_FAILED', 'SUBMISSION_FAILED', 'SUBMITTING', 'PAID'],
      );
      assert.equal(rows[3].submission_first_attempt_at, null);
      assert.equal(rows[3].submission_last_attempt_at, null);
      assert.ok(rows[1].submission_first_attempt_at < new Date(Date.now() - 10 * 60 * 1000));
      for (let index = 0; index < 3; index++)
        assert.deepEqual(rows[index].submission_last_attempt_at, before[index].updated_at);
      await assert.rejects(
        client.query("UPDATE orders SET status='UNKNOWN' WHERE order_seq=$1", [ids[0]]),
        { code: '23514' },
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f'",
          )
        ).rows[0].n,
        25,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal",
          )
        ).rows[0].n,
        10,
      );
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
