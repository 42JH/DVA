const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createTestPool } = require('./helpers/application.cjs');

test('056 adds only nullable failure evidence and preserves populated calls, analysis and recordings across rollback and upgrade', async () => {
  const owner = createTestPool();
  const name = 'dva_analysis_' + randomUUID().replaceAll('-', '');
  let probe;
  try {
    await owner.query('CREATE DATABASE ' + name);
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
      await client.query('BEGIN');
      for (const file of readdirSync(directory)
        .filter((p) => /^\d{3}-.+\.sql$/.test(p) && p < '056-')
        .sort())
        await client.query(readFileSync(join(directory, file), 'utf8'));
      await client.query('COMMIT');
      const id = (
        await client.query(
          "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at) VALUES('rtc_upgrade_analysis','01012345678',clock_timestamp()) RETURNING call_session_seq",
        )
      ).rows[0].call_session_seq;
      await client.query(
        "INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,complaints,payload_hash) VALUES($1,clock_timestamp(),clock_timestamp(),'[]',repeat('a',64))",
        [id],
      );
      await client.query(
        "INSERT INTO recordings(call_session_seq,object_key) VALUES($1,'recordings/upgrade-analysis.mp3')",
        [id],
      );
      const snapshot = async () =>
        (
          await client.query(
            "SELECT jsonb_build_object('calls',(SELECT jsonb_agg(to_jsonb(c)-'analysis_failed_at') FROM call_sessions c),'analyses',(SELECT jsonb_agg(to_jsonb(a)) FROM call_analyses a),'recordings',(SELECT jsonb_agg(to_jsonb(r)) FROM recordings r),'fks',(SELECT count(*) FROM pg_constraint WHERE contype='f')) AS data",
          )
        ).rows[0].data;
      const before = await snapshot();
      const sql = readFileSync(join(directory, '056-call-analysis-failure.sql'), 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await assert.rejects(client.query('SELECT 1/0'), { code: '22012' });
      await client.query('ROLLBACK');
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='analysis_failed_at'",
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(await snapshot(), before);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        (
          await client.query(
            "SELECT udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='analysis_failed_at'",
          )
        ).rows,
        [{ udt_name: 'timestamptz', is_nullable: 'YES', column_default: null }],
      );
      assert.equal(
        (
          await client.query(
            'SELECT analysis_failed_at FROM call_sessions WHERE call_session_seq=$1',
            [id],
          )
        ).rows[0].analysis_failed_at,
        null,
      );
      assert.equal(
        (
          await client.query(
            "INSERT INTO call_sessions(provider_call_id) VALUES('rtc_new_analysis') RETURNING analysis_failed_at",
          )
        ).rows[0].analysis_failed_at,
        null,
      );
    } finally {
      client.release();
    }
  } finally {
    if (probe) await probe.end();
    await owner.query('DROP DATABASE IF EXISTS ' + name);
    await owner.end();
  }
});
