function personaHead(suite) {
  const { test, pool, assert } = suite;
  test('persona HEAD: migration preserves pending intent and restores only evidenced historical heads', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
      CREATE TEMP TABLE ai_personas(ai_persona_seq integer PRIMARY KEY);
      CREATE TEMP TABLE ai_persona_versions(ai_persona_version_seq integer PRIMARY KEY,ai_persona_seq integer,status text,applied_at timestamptz);
      CREATE TEMP TABLE audit_logs(audit_log_seq integer,occurred_at timestamptz,target_type text,target_seq integer,action text,result text);
      INSERT INTO ai_personas VALUES(1),(2),(3),(4),(5),(6);
      INSERT INTO ai_persona_versions VALUES
        (11,1,'INACTIVE','2026-10-29'),(12,1,'INACTIVE',NULL),(13,1,'INACTIVE',NULL),
        (21,2,'ACTIVE','2026-10-30'),(22,2,'PENDING',NULL),
        (31,3,'INACTIVE',NULL),(32,3,'INACTIVE',NULL),
        (41,4,'INACTIVE','2026-10-28'),(42,4,'INACTIVE','2026-10-29'),
        (61,6,'ACTIVE','2026-10-28'),(62,6,'INACTIVE','2026-10-29');
      INSERT INTO audit_logs VALUES
        (1,'2026-10-29','AI_PERSONA_VERSION',11,'PERSONA_APPLIED','SUCCESS'),
        (2,'2026-10-30','AI_PERSONA_VERSION',12,'PERSONA_APPLIED','SUCCESS'),
        (3,'2026-10-31','AI_PERSONA_VERSION',13,'PERSONA_APPLY_FAILED','FAILED');
    `);
      await client.query(
        readFileSync(join(__dirname, '../migrations/034-persona-type-heads.sql'), 'utf8'),
      );
      assert.deepEqual(
        (
          await client.query('SELECT head_version_seq FROM ai_personas ORDER BY ai_persona_seq')
        ).rows.map((r) => r.head_version_seq),
        [12, 22, null, 42, null, 61],
      );
      assert.equal(
        (await client.query('SELECT count(*) FROM ai_persona_versions')).rows[0].count,
        '11',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
}

function draftStore(suite) {
  const { test, pool, assert } = suite;
  test('migration 039 adds an empty draft store to populated personas without changing any committed version', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE ai_personas,ai_persona_versions IN SHARE ROW EXCLUSIVE MODE');
      const snapshot = async () =>
        (
          await client.query(
            'SELECT jsonb_agg(to_jsonb(v) ORDER BY ai_persona_version_seq) AS versions FROM ai_persona_versions v',
          )
        ).rows[0].versions;
      const before = await snapshot();
      await client.query('DROP TABLE ai_persona_drafts');
      await client.query(
        readFileSync(join(__dirname, '../migrations/039-persona-drafts.sql'), 'utf8'),
      );
      assert.equal(
        (await client.query('SELECT count(*)::int AS n FROM ai_persona_drafts')).rows[0].n,
        0,
      );
      assert.deepEqual(await snapshot(), before);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
}

function latestHeads(suite) {
  const { test, pool, assert } = suite;
  test('automatic HEAD: migrations 035/036 reconcile then remove stored heads without losing versions', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
      CREATE TEMP TABLE ai_personas(ai_persona_seq integer PRIMARY KEY,head_version_seq integer);
      CREATE TEMP TABLE ai_persona_versions(ai_persona_version_seq integer PRIMARY KEY,ai_persona_seq integer,version integer,status text,application_id uuid);
      INSERT INTO ai_personas VALUES(1,101),(2,201),(3,NULL),(4,NULL);
      INSERT INTO ai_persona_versions VALUES
        (101,1,1,'ACTIVE','00000000-0000-4000-8000-000000000001'),(103,1,3,'INACTIVE',NULL),
        (201,2,1,'PENDING','00000000-0000-4000-8000-000000000002'),(202,2,2,'INACTIVE',NULL),
        (301,3,1,'INACTIVE',NULL);
    `);
      const before = (
        await client.query(
          'SELECT jsonb_agg(to_jsonb(v) ORDER BY ai_persona_version_seq) AS versions FROM ai_persona_versions v',
        )
      ).rows[0].versions;
      await client.query(
        readFileSync(join(__dirname, '../migrations/035-persona-latest-heads.sql'), 'utf8'),
      );
      assert.deepEqual(
        (
          await client.query('SELECT head_version_seq FROM ai_personas ORDER BY ai_persona_seq')
        ).rows.map((r) => r.head_version_seq),
        [103, 202, 301, null],
      );
      await client.query(
        readFileSync(
          join(__dirname, '../migrations/036-remove-redundant-persona-head.sql'),
          'utf8',
        ),
      );
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM pg_attribute WHERE attrelid='ai_personas'::regclass AND attname='head_version_seq' AND NOT attisdropped",
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (await client.query('SELECT ai_persona_seq FROM ai_personas ORDER BY ai_persona_seq')).rows,
        [1, 2, 3, 4].map((ai_persona_seq) => ({ ai_persona_seq })),
      );
      assert.deepEqual(
        (
          await client.query(
            'SELECT jsonb_agg(to_jsonb(v) ORDER BY ai_persona_version_seq) AS versions FROM ai_persona_versions v',
          )
        ).rows[0].versions,
        before,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
}

module.exports = { personaHead, draftStore, latestHeads };
