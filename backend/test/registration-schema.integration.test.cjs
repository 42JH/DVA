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

test('deployment verification requires persona deletion fields and the inactive-only guard', async () => {
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='065-persona-soft-delete.sql'",
    'ALTER TABLE ai_personas DROP COLUMN deleted_at',
    'ALTER TABLE ai_persona_drafts DROP COLUMN deleted_at',
    'ALTER TABLE ai_persona_versions DROP CONSTRAINT ai_persona_deleted_inactive_check',
  ])
    await verify([sql], 'Persona soft deletion schema or migration missing');
});

test('deployment verification requires employee policy and usable card uniqueness', async () => {
  await verify(
    ["DELETE FROM db_migrations.applied_versions WHERE version='063-member-payment-policy.sql'"],
    'Employee payment policy schema or migration missing',
  );
  for (const sql of [
    "DELETE FROM db_migrations.applied_versions WHERE version='064-payment-cards.sql'",
    'DROP INDEX payment_cards_company_active',
    'ALTER TABLE order_payment_requests DROP COLUMN card_payment_order_id',
  ])
    await verify([sql], 'Registered payment card schema or migration missing');
});

test('063 preserves existing company policy and copies department permission to each employee', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org = (
      await client.query(
        "INSERT INTO organizations(name,status,monthly_billing_enabled) VALUES('이관 결제','ACTIVE',false) RETURNING organization_seq",
      )
    ).rows[0].organization_seq;
    const members = [];
    for (const flag of [false, true]) {
      const customer = (
        await client.query(
          "INSERT INTO customers(name,phone_number,status) VALUES('이관 고객',$1,'ACTIVE') RETURNING customer_seq",
          ['010' + require('node:crypto').randomInt(10000000, 100000000)],
        )
      ).rows[0].customer_seq;
      const dept = (
        await client.query(
          'INSERT INTO departments(organization_seq,name,group_billing_enabled) VALUES($1,$2,$3) RETURNING department_seq',
          [org, String(flag), flag],
        )
      ).rows[0].department_seq;
      members.push(
        (
          await client.query(
            "INSERT INTO memberships(customer_seq,organization_seq,department_seq,employee_no,status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING membership_seq",
            [customer, org, dept, String(flag)],
          )
        ).rows[0].membership_seq,
      );
    }
    await client.query(
      'ALTER TABLE memberships DROP COLUMN monthly_billing_enabled, DROP COLUMN group_billing_enabled',
    );
    await client.query(
      'ALTER TABLE organizations ALTER COLUMN monthly_billing_enabled SET DEFAULT false',
    );
    await client.query(readFileSync(join(directory, '063-member-payment-policy.sql'), 'utf8'));
    assert.deepEqual(
      (
        await client.query(
          'SELECT monthly_billing_enabled,group_billing_enabled FROM memberships WHERE membership_seq=ANY($1::int[]) ORDER BY membership_seq',
          [members],
        )
      ).rows,
      [
        { monthly_billing_enabled: true, group_billing_enabled: false },
        { monthly_billing_enabled: true, group_billing_enabled: true },
      ],
    );
    assert.equal(
      (
        await client.query(
          'SELECT monthly_billing_enabled FROM organizations WHERE organization_seq=$1',
          [org],
        )
      ).rows[0].monthly_billing_enabled,
      false,
    );
    assert.equal(
      (
        await client.query(
          "INSERT INTO organizations(name,status) VALUES('신규 기본','ACTIVE') RETURNING monthly_billing_enabled",
        )
      ).rows[0].monthly_billing_enabled,
      true,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

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
    'Expected 28 foreign keys, found 29',
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

test('deployment verification requires complaint judging and draft reservations', async () => {
  await verify(
    ["DELETE FROM db_migrations.applied_versions WHERE version='057-call-complaint-judging.sql'"],
    'Complaint judging schema or migration missing',
  );
  await verify(
    ['ALTER TABLE order_parcel_drafts DROP COLUMN reserved_order_seq CASCADE'],
    'Parcel draft reservation schema or migration missing',
  );
});

test('058 backfills unique reservations from the order sequence without creating orders or losing legacy references', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const admin = (
      await client.query(
        "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('reservationMigration','예약 검증','not-for-login','OPERATOR','ACTIVE') RETURNING admin_user_seq",
      )
    ).rows[0].admin_user_seq;
    const before = (
      await client.query(
        'SELECT count(*)::int AS count,COALESCE(max(order_seq),0) AS max FROM orders',
      )
    ).rows[0];
    await client.query('ALTER TABLE order_parcel_drafts DROP COLUMN reserved_order_seq CASCADE');
    const draft = (
      await client.query(
        "INSERT INTO order_parcel_drafts(created_by_admin_user_seq,client_parcel_id,creation_payload,parcel_data,status,legacy_order_seq) VALUES($1,'05500000-0000-4000-8000-000000000058','{}','{}','INCOMPLETE',2147483000) RETURNING draft_seq",
        [admin],
      )
    ).rows[0].draft_seq;
    await client.query(
      readFileSync(join(directory, '058-parcel-draft-order-reservation.sql'), 'utf8'),
    );
    const row = (
      await client.query(
        'SELECT reserved_order_seq,legacy_order_seq FROM order_parcel_drafts WHERE draft_seq=$1',
        [draft],
      )
    ).rows[0];
    assert.ok(row.reserved_order_seq > before.max);
    assert.equal(row.legacy_order_seq, 2147483000);
    assert.equal(
      (await client.query('SELECT count(*)::int AS count FROM orders')).rows[0].count,
      before.count,
    );
    const unique = (
      await client.query(
        "SELECT count(*)::int AS count,count(DISTINCT reserved_order_seq)::int AS distinct_count FROM order_parcel_drafts WHERE status<>'RESUMED'",
      )
    ).rows[0];
    assert.equal(unique.count, unique.distinct_count);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
