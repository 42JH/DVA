const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { changedPaths, selectChecks } = require('./monolith-changes.cjs');

test('CLI returns strict scalar flags that Jenkins can read without a JSON parser', () => {
  const output = execFileSync(process.execPath, [path.join(__dirname, 'monolith-changes.cjs')], {
    encoding: 'utf8',
    env: { ...process.env, CI_BASE_COMMIT: '', SOURCE_COMMIT: '', SHOULD_DEPLOY: 'false' },
  });
  assert.equal(output.trim(), 'true,true,true,missing_baseline_or_changes,full');
});

test('webhook includes every monolith infrastructure directory and preserves event guards', () => {
  const source = readFileSync(path.join(__dirname, 'configure-monolith-trigger.groovy'), 'utf8');
  const literal = source.match(/setRegexpFilterExpression\('(.+)'\)/)[1];
  const pattern = new RegExp(literal.replaceAll('\\\\', '\\').replace(/^\(\?s\)/, ''), 's');
  const matches = (paths, options = {}) =>
    pattern.test(
      [
        options.event ?? 'push',
        options.project ?? '1462697',
        options.branch ?? 'refs/heads/develop-backend',
        options.after ?? 'a'.repeat(40),
        options.count ?? '1',
        JSON.stringify(paths),
      ].join('|'),
    );
  for (const file of [
    'backend/src/main.ts',
    'Jenkinsfile',
    'compose.prod.yaml',
    '.gitattributes',
    'infra/deploy/deploy.sh',
    'infra/nginx/default.prod.conf',
    'infra/https/setup.sh',
    'infra/jenkins/monolith-changes.cjs',
    'infra/database/migrate.sh',
    'infra/observability/test.mjs',
    'infra/payment-test/check.mjs',
  ])
    assert.equal(matches([file]), true, file);
  assert.equal(matches(['docs/README.md']), false);
  assert.equal(matches(['msa/Jenkinsfile']), false);
  assert.equal(matches(['backend/src/main.ts'], { event: 'merge_request' }), false);
  assert.equal(matches(['backend/src/main.ts'], { project: 'other' }), false);
  assert.equal(matches(['backend/src/main.ts'], { branch: 'refs/heads/develop-ai' }), false);
  assert.equal(matches(['backend/src/main.ts'], { after: '0'.repeat(40) }), false);
  assert.equal(matches(['docs/README.md'], { count: '21' }), true);
});

test('ordinary backend changes select backend regressions without unrelated infrastructure checks', () => {
  assert.deepEqual(selectChecks(['infra/observability/test.mjs']), {
    backend: false,
    observability: true,
    paymentDemo: false,
    full: false,
    reason: 'changed_paths',
  });
  assert.equal(selectChecks(['infra/payment-test/check.mjs']).paymentDemo, true);
  assert.equal(selectChecks(['backend/payment-test/public/index.html']).paymentDemo, true);
  assert.equal(selectChecks(['backend/payment-test/public/index.html']).backend, true);
  assert.equal(selectChecks(['backend/src/orders/orders.service.ts']).backend, true);
  assert.equal(selectChecks(['backend/src/orders/orders.service.ts']).full, false);
  for (const file of [
    'backend/src/auth/auth.service.ts',
    'backend/src/admins/admins.service.ts',
    'backend/src/common/pagination-query.ts',
    'backend/src/common/errors/api.exception.ts',
    'backend/src/database/database.service.ts',
    'backend/test/auth.integration.test.cjs',
  ])
    assert.deepEqual(
      selectChecks([file]),
      {
        backend: true,
        observability: false,
        paymentDemo: false,
        full: false,
        reason: 'changed_paths',
      },
      file,
    );
  assert.equal(
    selectChecks(['infra/observability/test.mjs', 'backend/src/orders/orders.service.ts']).backend,
    true,
  );
  assert.equal(
    selectChecks(['docs/README.md', 'frontend/src/main.ts', 'msa/Jenkinsfile']).backend,
    false,
  );
  for (const file of [
    'backend/src/config/environment.ts',
    'backend/src/app.module.ts',
    'backend/src/main.ts',
    'backend/src/configure-application.ts',
    'backend/package.json',
    'backend/package-lock.json',
    'backend/tsconfig.json',
    'backend/migrations/031-worker.sql',
    'backend/Dockerfile',
    'infra/database/migrate.sh',
    'infra/nginx/default.prod.conf',
    'infra/jenkins/monolith-changes.cjs',
    'Jenkinsfile',
    'unknown-new-file',
    'README.md.backup',
  ])
    assert.equal(selectChecks([file]).full, true, file);
  for (const files of [null, []]) assert.equal(selectChecks(files).full, true);
});

test('backend Markdown alone skips heavy checks; executable files and mixed changes remain checked', () => {
  for (const files of [
    ['backend/README.md'],
    ['backend/docs/guide.md', 'docs/database/notes.md'],
  ]) {
    const checks = selectChecks(files);
    assert.equal(checks.backend, false);
    assert.equal(checks.observability, false);
    assert.equal(checks.paymentDemo, false);
    assert.equal(checks.reason, 'documentation_only');
  }
  for (const file of ['backend/docs/schema.sql', 'backend/docs/tool.cjs', 'backend/docs/guide.md.js'])
    assert.equal(selectChecks([file]).backend, true, file);
  assert.equal(selectChecks(['backend/docs/guide.md', 'backend/src/auth/auth.service.ts']).backend, true);
  assert.equal(selectChecks(['backend/docs/guide.md', 'infra/deploy/deploy.sh']).full, true);
  assert.equal(selectChecks(['backend/src/old.ts', 'backend/docs/moved.md']).backend, true);
});

test('backend observability contracts also select the real monitoring stack checks', () => {
  for (const file of [
    'backend/src/observability/json-logger.ts',
    'backend/src/observability/observability.service.ts',
    'backend/src/common/http/request-context.ts',
    'backend/src/health/health.controller.ts',
    'backend/test/observability.test.cjs',
    'backend/test/observability.integration.test.cjs',
  ])
    assert.deepEqual(
      selectChecks([file]),
      {
        backend: true,
        observability: true,
        paymentDemo: false,
        full: false,
        reason: 'changed_paths',
      },
      file,
    );
  for (const files of [
    ['backend/src/auth/auth.service.ts', 'infra/observability/render.mjs'],
    ['infra/observability/render.mjs', 'backend/src/auth/auth.service.ts'],
  ])
    assert.equal(selectChecks(files).observability, true);
});

test('git comparison covers all commits, deletions and renames; missing or divergent history fails closed', () => {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, 'dva-monolith-ci-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const save = (name, body) => {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), body);
    git('add', '--all');
    git(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci-test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    const base = save('backend/old.ts', 'old');
    save('backend/src/auth/auth.service.ts', 'changed in first commit');
    const head = save('docs/notes.md', 'changed in second commit');
    assert.ok(changedPaths(base, head, directory).includes('backend/src/auth/auth.service.ts'));
    for (const deploy of ['true', 'false']) {
      const output = execFileSync(
        process.execPath,
        [path.join(__dirname, 'monolith-changes.cjs')],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, CI_BASE_COMMIT: base, SOURCE_COMMIT: head, SHOULD_DEPLOY: deploy },
        },
      );
      assert.equal(output.trim(), 'true,false,false,changed_paths,full', `deploy=${deploy}`);
    }
    const faqHead = save('backend/src/faqs/faqs.service.ts', 'isolated FAQ change');
    const selected = execFileSync(process.execPath, [path.join(__dirname, 'monolith-changes.cjs')], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, CI_BASE_COMMIT: head, SOURCE_COMMIT: faqHead },
    });
    assert.equal(selected.trim(), 'true,false,false,changed_paths,faq');
    const pinHead = save('backend/src/pins/pins.service.ts', 'PIN change after FAQ');
    const mixed = execFileSync(process.execPath, [path.join(__dirname, 'monolith-changes.cjs')], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, CI_BASE_COMMIT: head, SOURCE_COMMIT: pinHead },
    });
    assert.equal(mixed.trim(), 'true,false,false,changed_paths,faq+pins');
    const pipeline = readFileSync(path.join(__dirname, '../../Jenkinsfile'), 'utf8');
    const scalarPattern = pipeline.match(/assert selection ==~ \/(.+)\//)[1];
    assert.match(mixed.trim(), new RegExp('^' + scalarPattern + '$'));
    assert.ok(pipeline.includes('if (params.FULL_BACKEND_TESTS)'));
    assert.ok(pipeline.includes("env.BACKEND_TEST_PROFILE = 'full'"));
    renameSync(path.join(directory, 'backend/old.ts'), path.join(directory, 'docs/renamed.md'));
    const renamed = save('docs/notes.md', 'rename');
    const paths = changedPaths(head, renamed, directory);
    assert.ok(paths.includes('backend/old.ts'));
    assert.ok(paths.includes('docs/renamed.md'));
    assert.equal(selectChecks(paths).backend, true);
    assert.equal(changedPaths('b'.repeat(40), head, directory), null);
    assert.equal(changedPaths(head, base, directory), null);
    assert.equal(changedPaths('--bad-option', head, directory), null);
  } finally {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('dva-monolith-ci-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an isolated checkout survives the shared HEAD lock and preserves its interrupted checkout', () => {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, 'dva-checkout-ci-'));
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const source = path.join(directory, 'source');
  const shared = path.join(directory, 'workspace', 'dva-ci-linux-validation');
  const isolated = path.join(directory, 'workspace', 'dva-ci-linux-validation@build-116');
  mkdirSync(source);
  const commit = (body) => {
    writeFileSync(path.join(source, 'tracked.txt'), body);
    git(source, 'add', 'tracked.txt');
    git(
      source,
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci-test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'fixture',
    );
    return git(source, 'rev-parse', 'HEAD');
  };
  try {
    git(source, 'init', '-q');
    const previous = commit('previous success');
    const current = commit('next build');
    mkdirSync(path.dirname(shared), { recursive: true });
    git(directory, 'clone', '--no-hardlinks', source, shared);
    git(shared, 'checkout', '--detach', previous);
    writeFileSync(path.join(shared, '.git', 'HEAD.lock'), 'held by another operation');
    writeFileSync(path.join(shared, 'untracked.txt'), 'preserve this evidence');
    assert.throws(
      () => git(shared, 'checkout', '-f', current),
      (error) => error.status === 128 && /HEAD\.lock/.test(error.stderr),
    );
    const files = ['.git/HEAD', '.git/HEAD.lock', '.git/index', 'tracked.txt', 'untracked.txt'];
    const before = files.map((file) => readFileSync(path.join(shared, file)));
    git(directory, 'clone', '--no-hardlinks', source, isolated);
    git(isolated, 'checkout', '--detach', current);
    assert.equal(git(isolated, 'rev-parse', 'HEAD'), current);
    assert.equal(readFileSync(path.join(isolated, 'tracked.txt'), 'utf8'), 'next build');
    assert.deepEqual(changedPaths(previous, current, isolated), ['tracked.txt']);
    assert.deepEqual(
      files.map((file) => readFileSync(path.join(shared, file))),
      before,
    );
  } finally {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('dva-checkout-ci-'));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the entire pipeline uses a build-specific workspace and guards its final cleanup', () => {
  const pipeline = readFileSync(path.join(__dirname, '../../Jenkinsfile'), 'utf8');
  const agent = pipeline.slice(0, pipeline.indexOf('    options {'));
  assert.match(agent, /agent\s*\{\s*node\s*\{/);
  assert.ok(
    agent.includes('customWorkspace "workspace/${env.JOB_NAME}@build-${env.BUILD_NUMBER}"'),
  );
  assert.equal((pipeline.match(/customWorkspace/g) ?? []).length, 1);
  assert.ok(pipeline.includes('skipDefaultCheckout(true)'));
  assert.ok(pipeline.includes('disableConcurrentBuilds()'));
  assert.ok(pipeline.includes('def source = checkout scm'));
  assert.ok(pipeline.includes('archiveArtifacts'));
  const cleanup = pipeline.slice(pipeline.indexOf('        cleanup {'));
  assert.ok(cleanup.includes('pwd().endsWith("/${env.JOB_NAME}@build-${env.BUILD_NUMBER}")'));
  assert.ok(cleanup.includes("error('Refusing to clean a workspace outside this build')"));
  assert.ok(cleanup.indexOf('deleteDir()') > cleanup.indexOf('error('));
});
