"""Build each CI image once; parity runners consume the same immutable image IDs."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'msa-release/ci-images.json'
SERVICES = ('operations', 'customer', 'consultation', 'delivery', 'order')
SUITES = {
    'operations': ('customer-checks', 'operations-checks', 'operations', 'consultation', 'monolith-checks', 'monolith', 'liquibase'),
    'customer': ('customer-checks', 'customer', 'operations', 'monolith-checks', 'monolith', 'liquibase'),
    'consultation': ('consultation-checks', 'consultation', 'order', 'operations', 'customer', 'monolith-checks', 'monolith', 'liquibase'),
    'order': ('delivery-checks', 'delivery', 'order-checks', 'order', 'customer', 'consultation', 'operations', 'monolith-checks', 'monolith', 'liquibase'),
}


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def source_commit():
    source = os.environ.get('MSA_CI_ORIGINAL_COMMIT')
    if not source:
        return run('git', 'rev-parse', 'HEAD')
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('Invalid original CI source commit')
    reference = json.loads((ROOT / 'msa/parity/baseline.json').read_text())['commit']
    values = run('git', 'rev-parse', 'HEAD^', 'HEAD:msa', source + ':msa',
                 'HEAD:backend', reference + ':backend').splitlines()
    if len(values) != 5 or values[0] != source or values[1] != values[2] or values[3] != values[4]:
        raise RuntimeError('CI snapshot does not match the original MSA and pinned backend')
    return source


def required(suites, services, database):
    if set(suites) - SUITES.keys() or set(services) - set(SERVICES):
        raise ValueError('Unknown CI suite/service')
    images = set(services)
    for suite in suites:
        images.update(SUITES[suite])
    if database:
        images.add('liquibase')
    return sorted(images)


def context(key):
    service = key.removesuffix('-checks')
    target = ['--target', 'checks'] if key.endswith('-checks') else []
    if service in SERVICES:
        return [*target, '-f', str(ROOT / 'msa/services' / service / 'Dockerfile'), str(ROOT / 'msa')]
    if service not in ('monolith', 'liquibase') or (service == 'liquibase' and target):
        raise ValueError('Unknown image')
    return [*target, str(ROOT / ('backend' if service == 'monolith' else 'msa/liquibase'))]


def prepared_image(key):
    path = os.environ.get('MSA_CI_IMAGES')
    if not path:
        return None
    document = json.loads(Path(path).read_text())
    if document.get('commit') != source_commit():
        raise RuntimeError('CI images belong to a different source commit')
    if document.get('referenceTree') != run('git', 'rev-parse', 'HEAD:backend'):
        raise RuntimeError('CI images belong to a different monolith reference')
    subprocess.run(['git', 'diff', '--quiet', 'HEAD', '--', 'backend', 'msa'], cwd=ROOT, check=True)
    image = document['images'][key]
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image['id']):
        raise RuntimeError('Invalid CI image ID')
    actual = json.loads(run('docker', 'image', 'inspect', image['id']))[0]
    if actual['Id'] != image['id'] or actual['Config']['Labels'].get('dva.ci-run') != document['release']:
        raise RuntimeError('CI image identity/ownership mismatch')
    return image['id']


def build():
    release = os.environ['RELEASE_NAME']
    if not re.fullmatch(r'[0-9a-f]{40}-[0-9]+', release):
        raise ValueError('Invalid CI release')
    commit = source_commit()
    if release.rsplit('-', 1)[0] != commit or MANIFEST.exists():
        raise RuntimeError('Source mismatch or reused CI image manifest')
    out = MANIFEST.parent
    suites = (out / 'parity-suites.txt').read_text().split()
    services = (out / 'services.txt').read_text().split()
    database = (out / 'database-ci.txt').read_text().strip() == 'true'
    document = {'commit': commit, 'release': release, 'referenceTree': run('git', 'rev-parse', 'HEAD:backend'), 'images': {}}
    out.mkdir(exist_ok=True)
    MANIFEST.write_text(json.dumps(document))
    for key in required(suites, services, database):
        tag = os.environ['DB_IMAGE'] if key == 'liquibase' else f'docker.io/library/dva-ci-{key}:{release}'
        # Record before building so cleanup also covers a partially failed preparation.
        document['images'][key] = {'tag': tag}
        MANIFEST.write_text(json.dumps(document))
        subprocess.run(['docker', 'build', '--label', 'dva.ci-run=' + release, '-t', tag, *context(key)], cwd=ROOT, check=True, timeout=900)
        document['images'][key]['id'] = run('docker', 'image', 'inspect', tag, '--format', '{{.Id}}')
        MANIFEST.write_text(json.dumps(document, indent=2) + '\n')


def cleanup():
    if not MANIFEST.exists():
        return
    document = json.loads(MANIFEST.read_text())
    if document['release'] != os.environ['RELEASE_NAME']:
        raise RuntimeError('Refusing cleanup of another CI run')
    for key, image in document['images'].items():
        tags = [image['tag']]
        if key in SERVICES:
            tags.append(f"docker.io/library/dva-{key}:{document['release']}")
        for tag in tags:
            if not run('docker', 'image', 'ls', '--quiet', tag):
                continue
            actual = json.loads(run('docker', 'image', 'inspect', tag))[0]
            if (actual.get('Config', {}).get('Labels') or {}).get('dva.ci-run') != document['release'] or ('id' in image and actual['Id'] != image['id']):
                raise RuntimeError('Refusing cleanup of an unowned/changed CI image')
            subprocess.run(['docker', 'image', 'rm', tag], check=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['build']:
        build()
    elif sys.argv[1:] == ['cleanup']:
        cleanup()
    elif len(sys.argv) == 2:
        print(prepared_image(sys.argv[1]) or '')
    else:
        raise SystemExit('Specify build, cleanup or an image key')
