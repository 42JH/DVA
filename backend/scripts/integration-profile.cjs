const orderFlow = [
  'orders',
  'order-cancellation',
  'manual-orders',
  'manual-orders-failures',
  'order-billing',
  'order-payments',
  'order-submission-recovery',
  'parcel-drafts',
  'order-intake',
  'admin-parcel-drafts',
];
const lifecycle = ['soft-deletion', 'data-retention', 'home'];
const suites = {
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
    ...lifecycle,
  ],
  dashboard: [
    'home',
    'dashboard-optimization',
    'dashboard',
    'call-dashboard-metrics',
    'call-analysis',
    'call-insights-read',
    'ai-settings',
    'data-retention',
  ],
  persona: [
    'home',
    'dashboard-optimization',
    'persona-list-optimization',
    'ai-settings',
    'dashboard',
    'call-dashboard-metrics',
    'call-analysis',
    'data-retention',
  ],
  customers: [
    'admin-order-counts',
    'order-list-optimization',
    'call-list-optimization',
    'customers',
    'members',
    'caller-context',
    'customer-organizations',
    'pins',
    'company-registration',
    'orders',
    'manual-orders',
    'manual-orders-failures',
    'parcel-drafts',
    'order-intake',
    'admin-parcel-drafts',
    'consultations',
    'order-address-history',
    'pagination-query',
    ...lifecycle,
  ],
  companies: [
    'company-bulk-deletion',
    'admin-order-counts',
    'order-list-optimization',
    'call-list-optimization',
    'organizations',
    'members',
    'company-directory',
    'company-registration',
    'company-summaries',
    'company-deletion',
    'caller-context',
    'customer-organizations',
    'customers',
    'order-billing',
    'order-payments',
    'order-intake',
    'order-address-history',
    'dashboard',
    'consultations',
    'pagination-query',
    ...lifecycle,
  ],
  pins: [
    'pins',
    'orders',
    'parcel-drafts',
    'order-address-history',
    'pagination-query',
    ...lifecycle,
  ],
  drafts: [
    'admin-order-counts',
    'order-list-optimization',
    'parcel-drafts',
    'admin-parcel-drafts',
    'order-intake',
    'consultations',
    'customer-organizations',
    ...lifecycle,
  ],
  intake: [
    'admin-order-counts',
    'order-list-optimization',
    'call-list-optimization',
    'parcel-drafts',
    'admin-parcel-drafts',
    'order-intake',
    'order-payments',
    'order-billing',
    'order-submission-recovery',
    'consultations',
    ...lifecycle,
  ],
  orders: [
    'admin-order-counts',
    'order-list-optimization',
    'call-list-optimization',
    'dashboard-optimization',
    ...orderFlow,
    'order-address-history',
    'consultations',
    'caller-context',
    'call-events',
    'call-insights-read',
    'customer-organizations',
    'dashboard',
    ...lifecycle,
  ],
  payments: [
    ...orderFlow,
    'company-deletion',
    'company-summaries',
    'admin-order-counts',
    'order-list-optimization',
    'call-list-optimization',
    ...lifecycle,
  ],
  calls: [
    'call-list-optimization',
    'transcript-optimization',
    'dashboard-optimization',
    'consultations',
    'recordings',
    'call-analysis',
    'call-analysis-status',
    'call-insights-read',
    'customer-organizations',
    'pagination-query',
    'parcel-drafts',
    'order-intake',
    'dashboard',
    ...lifecycle,
  ],
  analysis: [
    'call-list-optimization',
    'transcript-optimization',
    'dashboard-optimization',
    'call-analysis',
    'call-events',
    'unanswered-questions',
    'unanswered-questions-read',
    'unanswered-questions-management',
    'call-analysis-status',
    'call-dashboard-metrics',
    'dashboard',
    'call-insights-read',
    'consultations',
    ...lifecycle,
  ],
  events: [
    'transcript-optimization',
    'call-events',
    'call-insights-read',
    'call-analysis',
    'call-analysis-status',
    'consultations',
    'faq-question-examples',
    'unanswered-questions',
    'unanswered-questions-read',
    'unanswered-questions-management',
    ...lifecycle,
  ],
  recordings: [
    'call-list-optimization',
    'transcript-optimization',
    'recordings',
    'active-call-count',
    'consultations',
    'call-analysis-status',
    'caller-context',
    'order-intake',
    ...lifecycle,
  ],
  active: ['active-call-count', 'consultations', ...lifecycle],
};

// Include direct callers and SQL consumers; shared foundations and module wiring stay full.
const sourceRules = [
  [
    /^orders\/(?:parcel-drafts\.|admin-parcel-drafts\.|dto\/(?:parcel-draft|admin-parcel-draft)\.)/,
    'drafts',
  ],
  [/^orders\/(?:order-intake\.|dto\/order-intake\.)/, 'intake'],
  [
    /^(?:payments\/|orders\/(?:order-payments\.|order-maintenance\.)|organizations\/organization-billing\.)/,
    'payments',
  ],
  [/^(?:orders|deliveries)\//, 'orders'],
  [/^(?:organizations|members)\//, 'companies'],
  [/^customers\//, 'customers'],
  [/^pins\//, 'pins'],
  [/^consultations\/(?:active-call-count\.|dto\/active-call-count\.)/, 'active'],
  [/^(?:webhooks\/pbx\/|consultations\/recording-playback\.)/, 'recordings'],
  [
    /^consultations\/(?:consultations\.(?:repository|controller)\.ts$|dto\/(?:call-query|call-response|transcript)\.)/,
    'calls',
  ],
  [
    /^call-insights\/(?:call-events(?:-read)?|call-event-input|dto\/(?:create-call-events|call-event-response))\./,
    'events',
  ],
  [
    /^(?:dashboard\/|call-insights\/(?:call-dashboard-metrics\.|dto\/create-call-dashboard-metrics\.))/,
    'dashboard',
  ],
  [/^call-insights\//, 'analysis'],
  [/^(?:faqs|unanswered-questions)\//, 'faq'],
  [/^ai-settings\//, 'persona'],
];
const testRules = [
  [
    /^(?:helpers\/faqs|faq-input|faq-seed|faqs|faq-notifications|faq-categories|faq-question-examples|unanswered-questions(?:-read|-management)?)$/,
    'faq',
  ],
  [
    /^(?:helpers\/orders|helpers\/manual-orders|helpers\/legacy-order-intake|orders(?:-[a-z-]+)?|order-input|order-validation|order-pricing|order-address-history|order-submission-recovery|dver|manual-orders(?:-failures)?)$/,
    'orders',
  ],
  [/^(?:order-payments|order-billing|payment-input|payment-recovery)$/, 'payments'],
  [/^(?:parcel-drafts|admin-parcel-drafts)$/, 'drafts'],
  [/^order-intake$/, 'intake'],
  [/^(?:customers|caller-context)$/, 'customers'],
  [/^(?:organizations|members|member-input|company-[a-z-]+|customer-organizations)$/, 'companies'],
  [/^pins$/, 'pins'],
  [/^(?:consultations|call-insights-read)$/, 'calls'],
  [/^call-analysis(?:-status)?$/, 'analysis'],
  [/^call-events$/, 'events'],
  [/^dashboard$/, 'dashboard'],
  [/^call-dashboard-metrics$/, 'dashboard'],
  [/^(?:recordings|recording-storage|recording-playback)$/, 'recordings'],
  [/^active-call-count$/, 'active'],
  [/^(?:helpers\/ai-settings|ai-settings(?:-[a-z-]+)?)$/, 'persona'],
];

function selectIntegrationProfile(paths) {
  if (!paths?.length) return 'full';
  const profiles = new Set();
  for (const path of paths) {
    if (
      /^(?:README\.md$|docs\/|frontend\/|ai\/|msa\/|backend\/README\.md$|backend\/docs\/.*\.md$)/.test(
        path,
      )
    )
      continue;
    if (path.endsWith('.module.ts') || /migrations/.test(path)) return 'full';
    let profile;
    if (/^backend\/src\/.*\.ts$/.test(path)) {
      profile = sourceRules.find(([pattern]) =>
        pattern.test(path.slice('backend/src/'.length)),
      )?.[1];
    } else if (/^backend\/test\/.*\.cjs$/.test(path)) {
      const name = path
        .slice('backend/test/'.length)
        .replace(/(?:\.integration)?\.test\.cjs$|\.cjs$/, '');
      profile = testRules.find(([pattern]) => pattern.test(name))?.[1];
      if (profile && path.endsWith('.integration.test.cjs') && !suites[profile].includes(name))
        return 'full';
    } else if (
      path.startsWith('backend/payment-test/') ||
      path.startsWith('backend/src/payments/assets/')
    )
      profile = 'payments';
    if (!profile) return 'full';
    profiles.add(profile);
  }
  return profiles.size ? [...profiles].sort().join('+') : 'full';
}

function integrationCommand(
  profile = 'full',
  command = require('../package.json').scripts['test:integration'],
) {
  if (profile === 'full') return command;
  const profiles = profile.split('+');
  if (!profiles.every((name) => Object.hasOwn(suites, name)))
    throw new Error('Unknown integration profile');
  // Production smoke owns its data instead of depending on unrelated auth/address-history tests.
  const required = new Set(
    ['database', 'webhook', 'runtime-fixture', ...profiles.flatMap((name) => suites[name])].map(
      (suite) => 'test/' + suite + '.integration.test.cjs',
    ),
  );
  const found = new Set();
  const selected = command.split(' && ').filter((group) => {
    if (
      !/^node --test(?: --test-concurrency=1)?(?: test\/[a-z0-9-]+\.integration\.test\.cjs)+$/.test(
        group,
      )
    )
      throw new Error('Unrecognized integration command; use the full profile');
    const files = group.split(' ').filter((arg) => arg.startsWith('test/'));
    for (const file of files) if (required.has(file)) found.add(file);
    return files.some((file) => required.has(file));
  });
  if (found.size !== required.size)
    throw new Error('Missing integration suites; use the full profile');
  return selected.join(' && ');
}

module.exports = { integrationCommand, selectIntegrationProfile };
