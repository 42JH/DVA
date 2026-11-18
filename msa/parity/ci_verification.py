"""Keep successful verification independent of a later rollout failure."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SCOPES = ('database', 'operations', 'customer', 'consultation', 'order', 'events', 'deployment')
POLICY_PATHS = ['msa/parity/ci_verification.py', 'msa/deploy/plan-apps.py',
                'msa/parity/ci_images.py', 'msa/parity/ci_workspace.py', 'msa/parity/baseline.json']
DB_PATHS = ['msa/liquibase/', *POLICY_PATHS, 'msa/parity/reference-tests.patch',
            ':(glob,exclude)msa/liquibase/**/*.md']
EVENT_PATHS = ['msa/shared/events/', 'msa/liquibase/changelog/', *POLICY_PATHS]
DEPLOY_PATHS = ['msa/deploy/', 'msa/Jenkinsfile', *POLICY_PATHS]


def changed(base, paths, root=None):
    root = ROOT if root is None else root
    if not re.fullmatch(r'[0-9a-f]{40}', base or ''):
        return True
    ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'],
                              cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ancestor.returncode != 0:
        return True
    if not paths:
        return False
    result = subprocess.run(['git', 'diff', '--quiet', base, 'HEAD', '--', *paths], cwd=root)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot compare verification inputs')
    return result.returncode == 1


def database_changed(base, root=None):
    root = ROOT if root is None else root
    baseline_path = 'msa/parity/baseline.json'
    if changed(base, [path for path in DB_PATHS if path != baseline_path], root):
        return True
    if not changed(base, [baseline_path], root):
        return False
    try:
        signatures = []
        for revision in (base, 'HEAD'):
            document = json.loads(subprocess.check_output(
                ['git', 'show', revision + ':' + baseline_path], cwd=root,
                text=True, stderr=subprocess.DEVNULL))
            if not re.fullmatch(r'[0-9a-f]{40}', document['commit']):
                raise ValueError('Invalid reference commit')
            migrations = document['inventory']['migrations']
            if not isinstance(migrations, list) or not migrations:
                raise ValueError('Missing source migrations')
            for row in migrations:
                if (not isinstance(row, dict) or set(row) != {'file', 'sha256'}
                    or not re.fullmatch(r'backend/migrations/[0-9]{3}-[A-Za-z0-9._-]+\.sql', row['file'])
                    or not re.fullmatch(r'[0-9a-f]{64}', row['sha256'])):
                    raise ValueError('Invalid source migration')
            if len({row['file'] for row in migrations}) != len(migrations):
                raise ValueError('Duplicate source migration')
            signatures.append(migrations)
        return signatures[0] != signatures[1]
    except (subprocess.CalledProcessError, ValueError, TypeError, KeyError):
        return True


def previous(scope, fallback='', root=None):
    root = ROOT if root is None else root
    if scope not in SCOPES:
        raise ValueError('Unknown verification scope')
    path = root / 'msa-release/verification-history.json'
    try:
        history = json.loads(path.read_text()) if path.exists() else {}
    except json.JSONDecodeError:
        history = {}
    stamp = history.get(scope, '') if isinstance(history, dict) else ''
    match = re.fullmatch(r'([0-9a-f]{40}):([1-9][0-9]*)', stamp) if isinstance(stamp, str) else None
    if match and not changed(match[1], [], root):
        return {'commit': match[1], 'build': int(match[2])}
    return {'commit': fallback, 'build': None}


def record(scope):
    if scope not in SCOPES:
        raise ValueError('Unknown verification scope')
    from ci_images import source_commit, prepared_image
    if scope not in ('events', 'deployment'):
        path = ROOT / ('msa/liquibase/verification.json' if scope == 'database' else
                       'msa/liquibase/verification-logs/' + scope + '/verification.json')
        report = json.loads(path.read_text())
        if report.get('passed') is not True:
            raise RuntimeError('Cannot record unsuccessful verification')
        if scope == 'database' and report.get('imageId') != prepared_image('liquibase'):
            raise RuntimeError('Database verification image does not match this run')
    stamp = source_commit() + ':' + os.environ['BUILD_NUMBER']
    if not re.fullmatch(r'[0-9a-f]{40}:[1-9][0-9]*', stamp):
        raise ValueError('Invalid verification stamp')
    (ROOT / 'msa-release' / ('verified-' + scope + '.txt')).write_text(stamp + '\n')
    print(scope + ' verification recorded: ' + stamp)


def reuse_database():
    from ci_images import prepared_image, source_commit
    origin = previous('database', os.environ.get('MSA_BASE_COMMIT', ''))
    if database_changed(origin['commit']):
        raise RuntimeError('Database inputs changed; a fresh verification is required')
    image_id = prepared_image('liquibase')
    if not image_id:
        raise RuntimeError('A verified current-run image manifest is required')
    report = {'passed': True, 'image': os.environ['DB_IMAGE'], 'imageId': image_id,
              'verificationOrigin': {**origin, 'reason': 'unchanged-verification-inputs'},
              'sourceCommit': source_commit()}
    (ROOT / 'msa/liquibase/verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print('Reused DB verification with identical inputs: ' + json.dumps(origin))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'record':
        record(sys.argv[2])
    elif sys.argv[1:] == ['reuse-database']:
        reuse_database()
    else:
        raise SystemExit('Use record SCOPE or reuse-database')
