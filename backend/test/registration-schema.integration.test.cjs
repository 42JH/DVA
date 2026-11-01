const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('./helpers/migrations.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
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

async function verify(changes = []) {
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
        message: 'Registration dates schema or migration missing',
      });
    else await client.query(verification);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('deployment verification accepts migration 033 with nullable registration dates and live defaults', () =>
  verify());
test('deployment verification rejects a missing migration 033 ledger entry', () =>
  verify([
    "DELETE FROM db_migrations.applied_versions WHERE version='033-organization-created-at.sql'",
  ]));
for (const table of ['organizations', 'departments'])
  test(`deployment verification rejects a missing ${table}.created_at`, () =>
    verify([`ALTER TABLE ${table} DROP COLUMN created_at`]));
test('deployment verification rejects a registration date without a timezone', () =>
  verify(['ALTER TABLE departments ALTER COLUMN created_at TYPE timestamp without time zone']));
test('deployment verification rejects registration dates without a creation default', () =>
  verify(['ALTER TABLE organizations ALTER COLUMN created_at DROP DEFAULT']));
test('deployment verification rejects a fixed registration timestamp default', () =>
  verify([
    "ALTER TABLE departments ALTER COLUMN created_at SET DEFAULT '2020-01-01T00:00:00Z'::timestamptz",
  ]));
test('deployment verification rejects a registration policy that cannot retain unknown legacy dates', () =>
  verify([
    'UPDATE organizations SET created_at=CURRENT_TIMESTAMP WHERE created_at IS NULL',
    'ALTER TABLE organizations ALTER COLUMN created_at SET NOT NULL',
  ]));
