const { createServer } = require('node:http');
const { Pool } = require('pg');
const assert = require('node:assert/strict');
const { createReceiver, eventHttpHandler } = require('../index.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PGHOST, 'events-db');
const pool = new Pool({ database: 'events_receiver_test' });
const receive = createReceiver({ pool, sources: { order: 'local-test-key-'.padEnd(40, 'a') },
  handlers: { 'order:OrderAccepted': (client, event) => client.query(
    'INSERT INTO effects(id,value) VALUES($1,$2)', [event.payload.orderSeq, event.payload]) } });
const server = createServer(eventHttpHandler(async (...args) => {
  const result = await receive(...args);
  if (process.argv[2] === 'pause-after-commit') {
    process.send({ committed: true });
    await new Promise(() => {});
  }
  return result;
}));
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(async () => { await pool.end(); process.exit(0); }); });
