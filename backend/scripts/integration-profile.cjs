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
    if (path.endsWith('.module.ts')) return 'full';
    if (
      /^backend\/(?:src\/faqs\/.*\.ts$|test\/(?:faq-input\.test\.cjs$|(?:faqs|faq-seed|faq-notifications|faq-categories|faq-question-examples)\.integration\.test\.cjs$|helpers\/faqs\.cjs$))/.test(
        path,
      )
    )
      profiles.add('faq');
    else if (
      /^backend\/(?:src\/dashboard\/.*\.ts$|test\/dashboard(?:\.integration)?\.test\.cjs$)/.test(
        path,
      )
    )
      profiles.add('dashboard');
    else return 'full';
  }
  return profiles.size === 1 ? [...profiles][0] : 'full';
}

function integrationCommand(
  profile = 'full',
  command = require('../package.json').scripts['test:integration'],
) {
  if (profile === 'full') return command;
  if (!Object.hasOwn(suites, profile)) throw new Error('Unknown integration profile');
  const required = new Set(
    // Runtime address-history smoke reads the accepted snapshot left by this integration suite.
    ['database', 'webhook', 'auth', 'auth-limits', 'order-address-history', ...suites[profile]].map(
      (suite) => `test/${suite}.integration.test.cjs`,
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
