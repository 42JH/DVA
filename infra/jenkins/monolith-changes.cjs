const { execFileSync } = require('node:child_process');

function allChecks(reason) {
  return { backend: true, observability: true, paymentDemo: true, full: true, reason };
}

function selectChecks(paths) {
  if (!paths?.length) return allChecks('missing_baseline_or_changes');
  const documentation = /^(?:README\.md$|docs\/|backend\/README\.md$|backend\/docs\/.*\.md$)/;
  const checks = {
    backend: false,
    observability: false,
    paymentDemo: false,
    full: false,
    reason: 'changed_paths',
  };
  if (paths.every((path) => documentation.test(path))) {
    checks.reason = 'documentation_only';
    return checks;
  }
  for (const path of paths) {
    if (documentation.test(path) || /^(?:frontend\/|ai\/|msa\/)/.test(path)) continue;
    if (/^infra\/observability\//.test(path)) checks.observability = true;
    else if (/^infra\/payment-test\//.test(path)) checks.paymentDemo = true;
    else if (/^backend\/payment-test\//.test(path)) {
      checks.backend = true;
      checks.paymentDemo = true;
    } else if (/^backend\//.test(path)) {
      if (
        /^backend\/(?:migrations\/|package(?:-lock)?\.json$|tsconfig\.json$|Dockerfile$|src\/(?:config\/|app\.module\.ts$|configure-application\.ts$|main\.ts$))/.test(
          path,
        )
      )
        return allChecks('shared_backend');
      // Any backend module change runs all backend regressions, including its callers.
      checks.backend = true;
      if (
        /^backend\/(?:src\/(?:observability\/|common\/http\/|health\/)|test\/observability(?:\.integration)?\.test\.cjs$)/.test(
          path,
        )
      )
        checks.observability = true;
    } else return allChecks('infrastructure_or_unknown_path');
  }
  return checks;
}

function changedPaths(base, head, cwd = process.cwd()) {
  const commit = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
  if (!commit.test(base ?? '') || !commit.test(head ?? '')) return null;
  try {
    const git = (...args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('merge-base', '--is-ancestor', base, head);
    // Renames become a deletion and addition so both old and new paths are checked.
    return git('diff', '--no-renames', '--name-only', '-z', base, head).split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

if (require.main === module) {
  const paths = changedPaths(process.env.CI_BASE_COMMIT, process.env.SOURCE_COMMIT);
  const checks = selectChecks(paths);
  console.log([checks.backend, checks.observability, checks.paymentDemo, checks.reason].join(','));
}

module.exports = { changedPaths, selectChecks };
