// Cross-platform Docker verification. Creates only disposable resources with a random name.
const { spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const run = 'dva-backend-check-' + randomBytes(6).toString('hex');
const network = run + '-net';
const database = run + '-db';
const image = run + ':test';
const runtimeImage = run + ':runtime';
const application = run + '-app';
const proxy = run + '-proxy';
const developmentProxy = run + '-development-proxy';
const httpsProxy = run + '-https';
const runtimeTests = run + '-runtime-tests';
const root = path.resolve(__dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), run + '-'));
const password = randomBytes(32).toString('hex');
const webhookToken = randomBytes(32).toString('hex');
const personaToken = randomBytes(32).toString('hex');
const businessToken = randomBytes(32).toString('hex');
const insightsToken = randomBytes(32).toString('hex');
let networkCreated = false,
  databaseCreated = false,
  imageCreated = false;
let runtimeCreated = false,
  applicationCreated = false,
  proxyCreated = false,
  developmentProxyCreated = false,
  httpsCreated = false,
  runtimeTestsCreated = false;
function docker(args, required = true) {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (required && (result.error || result.status !== 0))
    throw new Error('Backend Docker verification failed');
  return result.status === 0;
}
try {
  docker(['build', '--target', 'checks', '-t', image, root]);
  imageCreated = true;
  docker(['network', 'create', '--internal', network]);
  networkCreated = true;
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    database,
    '--network',
    network,
    '--network-alias',
    'db',
    '--memory',
    '256m',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-e',
    'POSTGRES_DB=dva_webhook_test',
    '-e',
    'POSTGRES_USER=test_user',
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    'postgres:17-alpine',
  ]);
  databaseCreated = true;
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    if (
      docker(
        [
          'exec',
          database,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'test_user',
          '-d',
          'dva_webhook_test',
        ],
        false,
      )
    ) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  docker([
    'run',
    '--rm',
    '--network',
    network,
    '--memory',
    '512m',
    '-e',
    'NODE_ENV=test',
    '-e',
    'DB_HOST=db',
    '-e',
    'DB_PORT=5432',
    '-e',
    'DB_USER=test_user',
    '-e',
    `DB_PASSWORD=${password}`,
    '-e',
    'DB_NAME=dva_webhook_test',
    '-e',
    'AI_AGENT_URL=http://ai.invalid:8000',
    '-e',
    `AI_BUSINESS_TOKEN=${businessToken}`,
    '-e',
    'SWAGGER_ENABLED=false',
    '-e',
    `DVA_TEST_DATABASE_VERIFY_SQL=${readFileSync(path.join(root, '../infra/database/verify.sql'), 'utf8')}`,
    image,
  ]);
  docker(['build', '-t', runtimeImage, root]);
  runtimeCreated = true;
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    application,
    '--network',
    network,
    '--network-alias',
    'backend',
    '--memory',
    '256m',
    '-e',
    'NODE_ENV=production',
    '-e',
    'SECURITY_LOG_HMAC_KEY=' + randomBytes(32).toString('hex'),
    '-e',
    'AUTH_PROXY_HOPS=2',
    '-e',
    'DB_HOST=db',
    '-e',
    'DB_PORT=5432',
    '-e',
    'DB_USER=test_user',
    '-e',
    `DB_PASSWORD=${password}`,
    '-e',
    'DB_NAME=dva_webhook_test',
    '-e',
    'AI_AGENT_URL=http://ai.invalid:8000',
    '-e',
    'CORS_ORIGINS=https://13.209.59.180',
    '-e',
    `PBX_WEBHOOK_TOKEN=${webhookToken}`,
    '-e',
    `AI_PERSONA_TOKEN=${personaToken}`,
    '-e',
    `AI_BUSINESS_TOKEN=${businessToken}`,
    '-e',
    `AI_INSIGHTS_TOKEN=${insightsToken}`,
    runtimeImage,
  ]);
  applicationCreated = true;
  docker([
    'create',
    '--name',
    proxy,
    '--network',
    network,
    '--network-alias',
    'proxy',
    '--memory',
    '64m',
    'nginx:stable-alpine',
  ]);
  proxyCreated = true;
  docker([
    'cp',
    path.join(root, '..', 'infra', 'nginx', 'default.prod.conf'),
    `${proxy}:/etc/nginx/conf.d/default.conf`,
  ]);
  docker(['start', proxy]);
  docker([
    'create',
    '--name',
    developmentProxy,
    '--network',
    network,
    '--network-alias',
    'development-proxy',
    '--memory',
    '64m',
    'nginx:stable-alpine',
  ]);
  developmentProxyCreated = true;
  docker([
    'cp',
    path.join(root, '../infra/nginx/default.conf'),
    `${developmentProxy}:/etc/nginx/conf.d/default.conf`,
  ]);
  docker(['start', developmentProxy]);
  docker(['exec', developmentProxy, 'nginx', '-t']);
  const certificateDirectory = path.join(temporary, 'letsencrypt', 'live', 'dva-ip');
  const secondaryCertificateDirectory = path.join(temporary, 'letsencrypt', 'live', 'dva-sslip');
  mkdirSync(certificateDirectory, { recursive: true });
  mkdirSync(secondaryCertificateDirectory, { recursive: true });
  const certificate = path.join(certificateDirectory, 'fullchain.pem');
  const privateKey = path.join(certificateDirectory, 'privkey.pem');
  let openssl = 'openssl';
  if (process.platform === 'win32' && spawnSync(openssl, ['version']).error?.code === 'ENOENT') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error('Git for Windows OpenSSL is required for HTTPS checks');
    openssl = path.resolve(git.stdout.trim(), '../../../usr/bin/openssl.exe');
  }
  const generated = spawnSync(openssl, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=backend',
    '-addext',
    'subjectAltName=DNS:backend',
    '-keyout',
    privateKey,
    '-out',
    certificate,
  ]);
  if (generated.error || generated.status !== 0)
    throw new Error('OpenSSL could not generate the disposable HTTPS certificate');
  copyFileSync(certificate, path.join(secondaryCertificateDirectory, 'fullchain.pem'));
  copyFileSync(privateKey, path.join(secondaryCertificateDirectory, 'privkey.pem'));
  // Emulate the host's published loopback port inside an isolated Docker network namespace.
  docker([
    'exec',
    '-d',
    application,
    'node',
    '-e',
    `
    const net = require('node:net');
    net.createServer(socket => {
      const upstream = net.connect(80, 'proxy');
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    }).listen(8082, '127.0.0.1');
  `,
  ]);
  docker([
    'create',
    '--name',
    httpsProxy,
    '--network',
    `container:${application}`,
    '--memory',
    '64m',
    'nginx:stable-alpine',
  ]);
  httpsCreated = true;
  docker([
    'cp',
    path.join(root, '../infra/https/https.conf'),
    `${httpsProxy}:/etc/nginx/conf.d/default.conf`,
  ]);
  docker(['cp', path.join(temporary, 'letsencrypt'), `${httpsProxy}:/etc/letsencrypt`]);
  docker(['start', httpsProxy]);
  docker(['exec', httpsProxy, 'nginx', '-t']);
  docker([
    'create',
    '--name',
    runtimeTests,
    '--network',
    network,
    '--memory',
    '512m',
    '-e',
    'NODE_ENV=test',
    '-e',
    `TEST_WEBHOOK_TOKEN=${webhookToken}`,
    '-e',
    `TEST_PERSONA_TOKEN=${personaToken}`,
    '-e',
    `TEST_BUSINESS_TOKEN=${businessToken}`,
    '-e',
    `TEST_INSIGHTS_TOKEN=${insightsToken}`,
    '-e',
    'TEST_HTTPS_API_ROOT=https://backend/api',
    '-e',
    'NODE_EXTRA_CA_CERTS=/test-proxy-ca.pem',
    image,
    'node',
    '--test',
    'test/runtime.integration.test.cjs',
  ]);
  runtimeTestsCreated = true;
  // Jenkins and its Docker daemon have separate filesystems; stream the client-local certificate.
  docker(['cp', certificate, `${runtimeTests}:/test-proxy-ca.pem`]);
  docker(['start', '--attach', runtimeTests]);
  docker(['exec', proxy, 'nginx', '-t']);
  docker([
    'exec',
    application,
    'node',
    '-e',
    'const fs=require("node:fs"); for(const p of ["test","scripts","node_modules/eslint",".env.development"]){ if(fs.existsSync(p)) process.exit(1); } if(require("./data/delivery-faq.json").length!==32 || !fs.existsSync("dist/faqs/bootstrap-faq.js")) process.exit(1); console.log("PASS: production image includes the FAQ bootstrap data and excludes tests, development tools and environment files.");',
  ]);
  // 임시 DB의 기존 FAQ를 보존하면서 운영 이미지에서도 초기 등록 명령이 실행되는지 확인한다.
  docker(['exec', application, 'node', 'dist/faqs/bootstrap-faq.js', 'runtimeAdmin83']);
  console.log(
    'PASS: backend checks, isolated PostgreSQL, production image and Nginx/PBX contracts.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (runtimeTestsCreated) docker(['rm', '-f', runtimeTests], false);
  if (httpsCreated) docker(['rm', '-f', httpsProxy], false);
  if (proxyCreated) docker(['rm', '-f', proxy], false);
  if (developmentProxyCreated) docker(['rm', '-f', developmentProxy], false);
  if (applicationCreated) docker(['rm', '-f', application], false);
  if (databaseCreated) docker(['rm', '-f', database], false);
  if (networkCreated) docker(['network', 'rm', network], false);
  if (imageCreated) docker(['image', 'rm', image], false);
  if (runtimeCreated) docker(['image', 'rm', runtimeImage], false);
  if (
    path.dirname(temporary) !== path.resolve(tmpdir()) ||
    !path.basename(temporary).startsWith(run + '-')
  )
    throw new Error('Unexpected verification temporary directory');
  rmSync(temporary, { recursive: true, force: true });
}
