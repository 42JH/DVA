const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { validateEnvironment } = require('../dist/config/environment');
const { DatabaseService } = require('../dist/database/database.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const database = new DatabaseService(new ConfigService(validateEnvironment(process.env)));
const table = 'foundation_tx_' + randomBytes(6).toString('hex');
before(async () => {
  await database.onModuleInit();
  await database.pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, value text NOT NULL)`);
});
after(async () => {
  try {
    await database.pool.query(`DROP TABLE IF EXISTS ${table}`);
  } finally {
    await database.onModuleDestroy();
  }
});

test('a transaction commits all writes on its dedicated client and returns the result', async () => {
  const result = await database.transaction(async (client) => {
    await client.query(`INSERT INTO ${table} VALUES ($1,$2)`, [1, 'committed']);
    await client.query(`INSERT INTO ${table} VALUES ($1,$2)`, [2, 'committed']);
    return 'stored';
  });
  assert.equal(result, 'stored');
  assert.equal((await database.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count, '2');
});

test('SQL failure rolls back earlier writes and releases the connection for subsequent work', async () => {
  await assert.rejects(
    database.transaction(async (client) => {
      await client.query(`INSERT INTO ${table} VALUES ($1,$2)`, [3, 'must rollback']);
      await client.query(`INSERT INTO ${table} VALUES ($1,$2)`, [1, 'duplicate']);
    }),
    (error) => error.code === '23505',
  );
  assert.equal(
    (await database.pool.query(`SELECT count(*) FROM ${table} WHERE id=3`)).rows[0].count,
    '0',
  );
  await database.transaction((client) =>
    client.query(`INSERT INTO ${table} VALUES ($1,$2)`, [4, 'after rollback']),
  );
  assert.equal(
    (await database.pool.query(`SELECT value FROM ${table} WHERE id=4`)).rows[0].value,
    'after rollback',
  );
});

test('a business failure also rolls back the entire transaction', async () => {
  const failure = new Error('business failure');
  await assert.rejects(
    database.transaction(async (client) => {
      await client.query(`UPDATE ${table} SET value=$1 WHERE id=1`, ['must rollback']);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(
    (await database.pool.query(`SELECT value FROM ${table} WHERE id=1`)).rows[0].value,
    'committed',
  );
});
