const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const {
  integrationCommand,
  selectIntegrationProfile,
} = require('../scripts/integration-profile.cjs');
const scripts = require('../package.json').scripts;
const full = scripts['test:integration'];
const examples = {
  faq: 'faqs/faqs.repository.ts',
  dashboard: 'dashboard/dto/dashboard-query.dto.ts',
  persona: 'ai-settings/persona-application.service.ts',
  customers: 'customers/customers.service.ts',
  companies: 'members/members.repository.ts',
  pins: 'pins/pins.service.ts',
  drafts: 'orders/parcel-drafts.service.ts',
  intake: 'orders/order-intake.service.ts',
  orders: 'orders/orders.service.ts',
  payments: 'payments/payments.service.ts',
  calls: 'consultations/consultations.repository.ts',
  analysis: 'call-insights/call-insights.service.ts',
  events: 'call-insights/call-events.repository.ts',
  recordings: 'webhooks/pbx/pbx-recording.worker.ts',
  active: 'consultations/active-call-count.service.ts',
};

test('selected FAQ/dashboard checks retain home and current statistics contracts', () => {
  assert.equal(selectIntegrationProfile(['backend/src/dashboard/home.service.ts']), 'dashboard');
  for (const profile of ['faq', 'dashboard'])
    assert.ok(integrationCommand(profile).includes('test/home.integration.test.cjs'), profile);
  assert.ok(integrationCommand('dashboard').includes('test/dashboard.integration.test.cjs'));
});

test('feature profiles retain current API consumers without old SQL benchmarks', () => {
  for (const [profile, names] of Object.entries({
    dashboard: ['home', 'dashboard'],
    persona: ['home', 'ai-settings'],
    customers: ['admin-order-counts', 'customers'],
    companies: ['company-bulk-deletion', 'admin-order-counts', 'members'],
    drafts: ['admin-order-counts', 'parcel-drafts'],
    intake: ['admin-order-counts', 'order-intake'],
    orders: ['admin-order-counts', 'orders'],
    calls: ['consultations', 'call-insights-read'],
    analysis: ['call-analysis', 'call-insights-read'],
    events: ['call-events'],
    recordings: ['recordings'],
  }))
    for (const name of names)
      assert.ok(
        files(integrationCommand(profile)).includes('test/' + name + '.integration.test.cjs'),
        profile + ': ' + name,
      );
  for (const profile of Object.keys(examples))
    assert.ok(
      files(integrationCommand(profile)).includes('test/home.integration.test.cjs'),
      profile + ': home',
    );
  for (const name of ['admin-order-counts', 'order-payments'])
    assert.ok(
      files(integrationCommand('payments')).includes('test/' + name + '.integration.test.cjs'),
      'payments: ' + name,
    );
});

test('feature changes and known feature fixtures select their affected regressions', () => {
  for (const [profile, path] of Object.entries(examples))
    assert.equal(selectIntegrationProfile(['backend/src/' + path]), profile, path);
  for (const [path, profile] of [
    ['backend/test/helpers/faqs.cjs', 'faq'],
    ['backend/test/helpers/orders.cjs', 'orders'],
    ['backend/test/orders-updates.cjs', 'orders'],
    ['backend/test/ai-settings-drafts.cjs', 'persona'],
    ['backend/test/parcel-drafts.integration.test.cjs', 'drafts'],
    ['backend/test/payment-recovery.test.cjs', 'payments'],
    ['backend/src/organizations/organization-billing.repository.ts', 'payments'],
    ['backend/src/consultations/recording-playback.service.ts', 'recordings'],
    ['backend/src/call-insights/dto/create-call-dashboard-metrics.dto.ts', 'dashboard'],
    ['backend/src/unanswered-questions/unanswered-questions.service.ts', 'faq'],
    ['backend/src/call-insights/call-events-read.controller.ts', 'events'],
    ['backend/payment-test/public/checkout.js', 'payments'],
  ])
    assert.equal(selectIntegrationProfile([path, 'backend/docs/guide.md']), profile, path);
});

test('mixed features form a stable union; shared foundations and unknown paths keep full checks', () => {
  assert.equal(
    selectIntegrationProfile([
      'backend/src/pins/pins.service.ts',
      'backend/src/faqs/faqs.service.ts',
      'frontend/src/page.ts',
    ]),
    'faq+pins',
  );
  for (const paths of [
    null,
    [],
    ['backend/docs/guide.md'],
    ...[
      'backend/src/auth/auth.service.ts',
      'backend/src/common/mobile-phone.ts',
      'backend/src/database/database.service.ts',
      'backend/src/retention/retention.repository.ts',
      'backend/src/consultations/call-session.repository.ts',
      'backend/src/consultations/consultations.service.ts',
      'backend/src/faqs/faqs.module.ts',
      'backend/test/helpers/application.cjs',
      'backend/test/new.integration.test.cjs',
      'backend/test/company-new.integration.test.cjs',
      'backend/test/orders-new.integration.test.cjs',
      'backend/test/orders-migrations.cjs',
      'backend/test/ai-settings-migrations.cjs',
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

function files(command) {
  return command.split(' ').filter((arg) => arg.startsWith('test/'));
}

test('selection preserves serial groups, core transactions/webhooks and independent runtime fixtures', () => {
  assert.equal(integrationCommand(), full);
  for (const profile of Object.keys(examples)) {
    const command = integrationCommand(profile);
    assert.ok(command.length < full.length, profile);
    for (const suite of ['database', 'webhook', 'runtime-fixture'])
      assert.ok(
        files(command).includes('test/' + suite + '.integration.test.cjs'),
        profile + ': ' + suite,
      );
    assert.ok(!files(command).includes('test/auth.integration.test.cjs'), profile);
    assert.ok(!files(command).includes('test/auth-limits.integration.test.cjs'), profile);
    let previous = -1;
    for (const group of command.split(' && ')) {
      const index = full.split(' && ').indexOf(group);
      assert.ok(index > previous, 'whole groups keep the authoritative manifest order');
      previous = index;
    }
    assert.equal(files(command).length, new Set(files(command)).size);
  }
  for (const profile of ['orders', 'payments', 'intake'])
    for (const suite of ['order-payments', 'order-submission-recovery', 'order-intake'])
      assert.ok(
        files(integrationCommand(profile)).includes('test/' + suite + '.integration.test.cjs'),
      );
  const union = new Set([
    ...files(integrationCommand('faq')),
    ...files(integrationCommand('pins')),
  ]);
  assert.deepEqual(new Set(files(integrationCommand('pins+faq+pins'))), union);
});

test('full manifests include every unit/DB entry exactly once and leave runtime to its own runner', () => {
  const expected = readdirSync(__dirname).filter(
    (file) => file.endsWith('.integration.test.cjs') && file !== 'runtime.integration.test.cjs',
  );
  const actual = files(full).map((file) => file.slice(5));
  assert.deepEqual([...actual].sort(), expected.sort());
  for (const entry of expected) {
    const profile = selectIntegrationProfile(['backend/test/' + entry]);
    assert.ok(files(integrationCommand(profile)).includes('test/' + entry), entry);
  }
  const units = readdirSync(__dirname).filter(
    (file) => file.endsWith('.test.cjs') && !file.endsWith('.integration.test.cjs'),
  );
  assert.deepEqual(
    files(scripts['test:compiled'])
      .map((file) => file.slice(5))
      .sort(),
    units.sort(),
  );
});

test('invalid profiles and incomplete or unrecognized manifests cannot silently omit checks', () => {
  for (const profile of ['faq; echo unsafe', '', 'full+faq', 'faq+unknown'])
    assert.throws(() => integrationCommand(profile), /Unknown integration profile/);
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
