// Run locally with explicit DB settings. Password is read from stdin, never argv or logs.
const { Pool } = require('pg');
const { hashPassword } = require('../dist/auth/password');
const { randomUUID } = require('node:crypto');
async function main() {
  const [loginId, name] = process.argv.slice(2);
  if (!loginId || !/^[A-Za-z0-9]{1,20}$/.test(loginId) || !name || !/\S/u.test(name))
    throw new Error('Usage: bootstrap-admin.cjs <loginId> <name>; provide password on stdin.');
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'])
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 102400) throw new Error('Input exceeds request size limit');
    chunks.push(chunk);
  }
  // Remove only the terminal line ending added by the input pipe, preserving password spaces.
  const password = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
  if ([...password].length < 6) throw new Error('Password must contain at least 6 characters');
  const hash = await hashPassword(password);
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 2000,
  });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261026,83)');
    if ((await client.query("SELECT 1 FROM admin_users WHERE role='SYSTEM_ADMIN'")).rowCount)
      throw new Error('A system administrator already exists');
    const result = await client.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,$2,$3,'SYSTEM_ADMIN','ACTIVE') RETURNING admin_user_seq",
      [loginId, name, hash],
    );
    await client.query(
      "INSERT INTO audit_logs(actor_type,action,target_type,target_seq,request_id,result,metadata) VALUES('SYSTEM','ADMIN_BOOTSTRAP','ADMIN_USER',$1,$2,'SUCCESS','{}')",
      [result.rows[0].admin_user_seq, randomUUID()],
    );
    await client.query('COMMIT');
    console.log('Initial administrator created.');
  } catch {
    if (client) await client.query('ROLLBACK');
    throw new Error('Administrator creation failed; no account was changed.');
  } finally {
    if (client) client.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
