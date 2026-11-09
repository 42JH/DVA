"""Isolate the existing 055 regressions from later backend API changes."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def prepare():
    reference = json.loads((ROOT / 'msa/parity/baseline.json').read_text())['commit']
    if not re.fullmatch(r'[0-9a-f]{40}', reference):
        raise ValueError('Invalid pinned monolith reference')
    original = git(ROOT, 'rev-parse', 'HEAD')
    subprocess.run(['git', '-C', str(ROOT), 'diff', '--quiet', 'HEAD', '--', 'msa'], check=True)
    snapshot = ROOT / 'msa/.ci-source'
    if snapshot.exists() or snapshot.is_symlink():
        raise RuntimeError('CI source snapshot already exists; use a clean workspace')
    git(ROOT, 'cat-file', '-e', reference + '^{commit}')
    git(ROOT, 'clone', '--shared', '--no-checkout', str(ROOT), str(snapshot))
    git(snapshot, 'config', 'core.autocrlf', 'false')
    # Only the generated, detached repository changes; the checked-out backend stays untouched.
    git(snapshot, 'update-ref', '--no-deref', 'HEAD', original)
    git(snapshot, 'read-tree', original)
    paths = ['msa', 'backend', *[p for p in ('.gitignore', '.gitattributes') if (ROOT / p).is_file()]]
    git(snapshot, 'restore', '--source', original, '--worktree', '--', *paths)
    git(snapshot, 'restore', '--source', reference, '--worktree', '--', 'backend')
    fixture_patch = ROOT / 'msa/parity/reference-tests.patch'
    if fixture_patch.exists():
        content = fixture_patch.read_text()
        paths = subprocess.check_output(['git', '-C', str(snapshot), 'apply', '--unidiff-zero', '--numstat', '-'],
                                        input=content, text=True).splitlines()
        allowed = {'backend/test/helpers/' + name + '.cjs' for name in ('application', 'orders', 'manual-orders')}
        if {line.split('\t')[-1] for line in paths} != allowed:
            raise RuntimeError('Reference fixture patch must only update the three business helpers')
        subprocess.run(['git', '-C', str(snapshot), 'apply', '--unidiff-zero', '--check', '-'], input=content, text=True, check=True)
        subprocess.run(['git', '-C', str(snapshot), 'apply', '--unidiff-zero', '-'], input=content, text=True, check=True)
    git(snapshot, 'add', '--', 'backend')
    tree = git(snapshot, 'write-tree')
    commit = git(snapshot, '-c', 'user.name=Dva CI verification', '-c', 'user.email=ci@dva.invalid',
                 'commit-tree', tree, '-p', original, '-m', 'Isolated monolith reference for CI')
    git(snapshot, 'update-ref', 'HEAD', commit)
    out = ROOT / 'msa-release'
    out.mkdir(exist_ok=True)
    (snapshot / 'msa-release').symlink_to(out, target_is_directory=True)
    logs = ROOT / 'msa/liquibase/verification-logs'
    logs.mkdir(exist_ok=True)
    (snapshot / 'msa/liquibase/verification-logs').symlink_to(logs, target_is_directory=True)
    (snapshot / 'msa/liquibase/verification.json').symlink_to(ROOT / 'msa/liquibase/verification.json')
    report = {'sourceCommit': original, 'snapshotCommit': commit, 'referenceCommit': reference,
              'referenceTree': git(snapshot, 'rev-parse', reference + ':backend'),
              'snapshotBackendTree': git(snapshot, 'rev-parse', 'HEAD:backend'),
              'testFixturePatch': git(ROOT, 'hash-object', str(fixture_patch)) if fixture_patch.exists() else None,
              'msaTree': git(snapshot, 'rev-parse', 'HEAD:msa')}
    (out / 'reference.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return snapshot


if __name__ == '__main__':
    prepare()
