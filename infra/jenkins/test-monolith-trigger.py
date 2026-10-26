"""Run on the Jenkins host as root. Exercise the public webhook without scheduling builds."""
import json
from pathlib import Path
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

HOME = Path('/home/ubuntu/dva-jenkins/home')
JOB = HOME / 'jobs/dva-ci-linux-validation'
MSA = HOME / 'jobs/dva-msa'
URL = 'https://13.209.59.180/jenkins/project/dva-ci-linux-validation'
tree = ET.parse(JOB / 'config.xml').getroot()
token = tree.findtext('.//org.jenkinsci.plugins.gwt.GenericTrigger/token')
assert token, 'Configure the monolith GenericTrigger first.'
before = {job: (job / 'nextBuildNumber').read_text() for job in (JOB, MSA)}
msa_config = (MSA / 'config.xml').read_bytes()


def check(name, paths, expected, *, count=1, branch='develop-backend',
          event='push', project=1462697, after='a' * 40, valid_token=True, removed=False):
    commit = {'added': [], 'modified': [], 'removed': []}
    commit['removed' if removed else 'modified'] = paths
    payload = {'object_kind': event, 'project': {'id': project},
               'ref': 'refs/heads/' + branch, 'after': after,
               'total_commits_count': count, 'commits': [commit]}
    request = urllib.request.Request(URL, data=json.dumps(payload).encode(), headers={
        'Content-Type': 'application/json', 'gwt-dry-run': 'true',
        'X-Gitlab-Token': token if valid_token else 'invalid-test-token',
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.load(response)
        jobs = result.get('jobs', {})
        matched = jobs.get('dva-ci-linux-validation', {}).get('triggered', False)
        assert not (set(jobs) - {'dva-ci-linux-validation'}), 'Another job was selected.'
        assert matched is expected, f'{name}: expected {expected}, got {matched}'
    except urllib.error.HTTPError as error:
        assert not valid_token and error.code in (401, 403, 404), f'{name}: HTTP {error.code}'
    print(f'PASS: {name}')


check('backend changes match', ['backend/src/main.ts'], True)
check('MSA-only changes do not match', ['msa/services/customer/src/main.ts'], False)
check('mixed backend/MSA changes match monolith', ['msa/Jenkinsfile', 'backend/src/main.ts'], True)
check('backend deletion matches', ['backend/src/old.ts'], True, removed=True)
check('Jenkinsfile matches', ['Jenkinsfile'], True)
check('deployment configuration matches', ['infra/nginx/default.prod.conf'], True)
check('compose configuration matches', ['compose.prod.yaml'], True)
check('unrelated docs do not match', ['README.md'], False)
check('other branch does not match', ['backend/src/main.ts'], False, branch='develop-ai')
check('other project does not match', ['backend/src/main.ts'], False, project=1)
check('MR event does not match', ['backend/src/main.ts'], False, event='merge_request')
check('branch deletion does not match', ['backend/src/main.ts'], False, after='0' * 40)
check('invalid token rejected', ['backend/src/main.ts'], False, valid_token=False)
check('truncated large push conservatively matches', ['msa/Jenkinsfile'], True, count=21)
assert {job: (job / 'nextBuildNumber').read_text() for job in (JOB, MSA)} == before
assert (MSA / 'config.xml').read_bytes() == msa_config
print('PASS: public HTTPS routing, authentication, path selection; no builds scheduled; MSA unchanged.')
