const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  integrationCommand,
  selectIntegrationProfile,
} = require('../scripts/integration-profile.cjs');
const full = require('../package.json').scripts['test:integration'];

test('selected FAQ/dashboard checks retain the home consumer and shared-statistics regression', () => {
  assert.equal(selectIntegrationProfile(['backend/src/dashboard/home.service.ts']), 'dashboard');
  for (const profile of ['faq', 'dashboard'])
    assert.ok(integrationCommand(profile).includes('test/home.integration.test.cjs'), profile);
  assert.ok(
    integrationCommand('dashboard').includes('test/dashboard-optimization.integration.test.cjs'),
  );
});

test('only isolated FAQ and dashboard changes narrow the integration profile', () => {
  assert.equal(selectIntegrationProfile(['backend/src/faqs/faqs.repository.ts']), 'faq');
  assert.equal(
    selectIntegrationProfile([
      'backend/src/faqs/dto/faq-request.dto.ts',
      'backend/test/helpers/faqs.cjs',
      'backend/docs/faq.md',
    ]),
    'faq',
  );
  assert.equal(
    selectIntegrationProfile([
      'backend/src/dashboard/dto/dashboard-query.dto.ts',
      'backend/test/dashboard.integration.test.cjs',
    ]),
    'dashboard',
  );
  for (const paths of [
    null,
    [],
    ['backend/docs/guide.md'],
    ['backend/src/faqs/faqs.module.ts'],
    ['backend/src/dashboard/dashboard.module.ts'],
    ['backend/src/faqs/faqs.service.ts', 'backend/src/dashboard/dashboard.service.ts'],
    ...[
      'backend/src/auth/auth.service.ts',
      'backend/src/orders/orders.service.ts',
      'backend/src/payments/payments.service.ts',
      'backend/src/common/input.ts',
      'backend/src/call-insights/call-events.repository.ts',
      'backend/test/helpers/application.cjs',
      'backend/test/new.integration.test.cjs',
      'backend/migrations/057-new.sql',
      'backend/package.json',
      'backend/scripts/check.cjs',
      'infra/nginx/default.prod.conf',
      'Jenkinsfile',
      'unknown',
    ].map((path) => ['backend/src/faqs/faqs.service.ts', path]),
  ])
    assert.equal(selectIntegrationProfile(paths), 'full', JSON.stringify(paths));
});

test('selected commands retain core checks, complete existing groups and their order', () => {
  assert.equal(integrationCommand(), full);
  assert.equal(integrationCommand('full'), full);
  const required = {
    faq: [
      'faq-seed',
      'faqs',
      'faq-notifications',
      'faq-categories',
      'faq-question-examples',
      'unanswered-questions',
      'unanswered-questions-read',
      'unanswered-questions-management',
      'call-events',
      'call-insights-read',
      'pagination-query',
      'soft-deletion',
      'data-retention',
    ],
    dashboard: [
      'dashboard',
      'call-dashboard-metrics',
      'call-analysis',
      'call-insights-read',
      'ai-settings',
      'data-retention',
    ],
  };
  for (const profile of ['faq', 'dashboard']) {
    const command = integrationCommand(profile);
    assert.ok(command.length < full.length);
    for (const suite of [
      'database',
      'webhook',
      'auth',
      'auth-limits',
      'order-address-history',
      ...required[profile],
    ])
      assert.ok(
        command.split(' ').includes(`test/${suite}.integration.test.cjs`),
        `${profile}: ${suite}`,
      );
    let previous = -1;
    for (const group of command.split(' && ')) {
      const index = full.split(' && ').indexOf(group);
      assert.ok(index > previous, 'whole groups stay in the authoritative manifest order');
      previous = index;
    }
    assert.ok(!command.includes('test/orders.integration.test.cjs'));
    assert.ok(!command.includes('test/runtime.integration.test.cjs'));
  }
});

test('invalid profiles and incomplete or unknown command manifests cannot silently omit checks', () => {
  assert.throws(() => integrationCommand('faq; echo unsafe'), /Unknown integration profile/);
  assert.throws(
    () =>
      integrationCommand(
        'faq',
        full.replace('test/faqs.integration.test.cjs', 'test/renamed.integration.test.cjs'),
      ),
    /Missing integration suites/,
  );
  assert.throws(
    () => integrationCommand('dashboard', full + ' && node scripts/new-check.cjs'),
    /Unrecognized integration command/,
  );
});
