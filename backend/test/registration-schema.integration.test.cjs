const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const pool = createTestPool();
const directory = join(__dirname, '../migrations');
const verification = (
  process.env.DVA_TEST_DATABASE_VERIFY_SQL ??
  readFileSync(join(__dirname, '../../infra/database/verify.sql'), 'utf8')
)
  .replace(/^\\set[^\r\n]*$/gm, '')
  .replace(/^BEGIN READ ONLY;\r?$/gm, '')
  .replace(/^COMMIT;\r?$/gm, '');
before(async () => migrate(pool));
after(async () => pool.end());

async function verify(changes = [], message = 'Registration dates schema or migration missing') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'CREATE SCHEMA IF NOT EXISTS db_migrations; CREATE TABLE IF NOT EXISTS db_migrations.applied_versions(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    for (const file of readdirSync(directory).filter((name) => /^\d{3}-.+\.sql$/.test(name)))
      await client.query(
        'INSERT INTO db_migrations.applied_versions(version,sha256) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',
        [
          file,
          createHash('sha256')
            .update(readFileSync(join(directory, file)))
            .digest('hex'),
        ],
      );
    for (const sql of changes) await client.query(sql);
    if (changes.length)
      await assert.rejects(client.query(verification), {
        message,
      });
    else await client.query(verification);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('deployment verification accepts the complete current schema and migration checksums', () =>
  verify());

test('deployment verification requires 055, logical references, uniqueness and the finalization guard', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='055-parcel-draft-intake.sql'",
    'ALTER TABLE order_parcel_drafts DROP COLUMN order_seq',
    'DROP INDEX parcel_draft_source_key',
    'ALTER TABLE call_sessions DROP CONSTRAINT call_order_finalization_check',
  ])
    await verify([sql], 'Parcel draft intake schema or migration missing');
  await verify(
    [
      'ALTER TABLE order_parcel_drafts ADD FOREIGN KEY(customer_seq) REFERENCES customers(customer_seq)',
    ],
    'Expected 25 foreign keys, found 26',
  );
});

test('deployment verification requires 056 and cannot infer failure through a default or change its timestamp type', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='056-call-analysis-failure.sql'",
    'ALTER TABLE call_sessions DROP COLUMN analysis_failed_at',
    'ALTER TABLE call_sessions ALTER COLUMN analysis_failed_at SET DEFAULT clock_timestamp()',
    'ALTER TABLE call_sessions ALTER COLUMN analysis_failed_at TYPE timestamp without time zone',
  ])
    await verify([sql], 'Call analysis failure schema or migration missing');
});
