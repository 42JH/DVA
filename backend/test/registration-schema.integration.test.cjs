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

test('deployment verification accepts migration 033 with nullable registration dates and live defaults', () =>
  verify());

test('deployment verification requires migration 045, soft deletion and the fenced retention guard', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='045-data-retention.sql'",
    'ALTER TABLE orders DROP COLUMN closed_at',
    'ALTER TABLE call_sessions DROP COLUMN deleted_at',
    'ALTER TABLE call_sessions DROP CONSTRAINT call_purge_claim_pair',
  ])
    await verify([sql], 'Data retention schema or migration missing');
});

test('deployment verification requires active-row employee uniqueness', () =>
  verify(
    ['DROP INDEX memberships_organization_seq_employee_no_key'],
    'Active organization/employee uniqueness missing',
  ));

test('deployment verification requires migration 047, legacy column removal and the call time guard', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='047-remove-unused-schema.sql'",
    'ALTER TABLE company_pins ADD COLUMN search_text text',
    'ALTER TABLE call_sessions ADD COLUMN end_reason text',
    'ALTER TABLE call_sessions DROP CONSTRAINT call_sessions_check',
  ])
    await verify([sql], 'Unused schema removal or migration missing');
  await verify(
    ['ALTER TABLE personal_pins DROP COLUMN search_text'],
    'Generated PIN search columns missing',
  );
});

test('deployment verification requires migration 046 and the persistent retry window', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='046-order-submission-retry-window.sql'",
    'DROP INDEX orders_submission_retry_idx',
    'ALTER TABLE orders DROP COLUMN submission_first_attempt_at',
    'ALTER TABLE orders DROP COLUMN submission_last_attempt_at',
    'ALTER TABLE orders DROP CONSTRAINT orders_status_check',
  ])
    await verify([sql], 'Order submission retry schema or migration missing');
});

test('deployment verification requires migration 037 and an undecided payment default', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='037-undecided-order-payment-method.sql'",
    "ALTER TABLE orders ALTER COLUMN payment_method_type SET DEFAULT 'billing'",
  ])
    await verify([sql], 'Undecided payment schema or migration missing');
});

test('deployment verification requires migration 038 and unique empty-result call identities', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='038-empty-ai-order-results.sql'",
    'ALTER TABLE empty_ai_order_results DROP CONSTRAINT empty_ai_order_results_call_session_seq_key',
  ])
    await verify([sql], 'Empty AI order result schema or migration missing');
});

test('deployment verification requires migration 039 and one revisioned draft per persona', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='039-persona-drafts.sql'",
    'ALTER TABLE ai_persona_drafts DROP CONSTRAINT ai_persona_drafts_pkey',
    'ALTER TABLE ai_persona_drafts ALTER COLUMN draft_revision DROP NOT NULL',
    'ALTER TABLE ai_persona_drafts DROP COLUMN base_version',
  ])
    await verify([sql], 'Persona draft schema or migration missing');
});
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
