"""Run the actual Jenkins delivery loops with an SSH peer that drains stdin."""
import re
import subprocess
import textwrap
import unittest

import test_deploy


SERVICES = ('operations', 'customer', 'consultation', 'delivery', 'order')
SSH_PEER = r'''
if name == 'ssh':
    # OpenSSH forwards inherited stdin unless explicitly detached.
    if '-n' not in args:
        sys.stdin.read()
    if 'bash remote-app.sh' in args[-1]:
        import shlex
        parts = shlex.split(args[-1])
        position = parts.index('remote-app.sh')
        service, release, action = parts[position + 1:position + 4]
        if os.environ.get('FAIL_APP_SERVICE') == service:
            sys.exit(9)
        if os.environ.get('MISSING_APP_MARKER') != service:
            marker = 'DVA_APP_IMAGE_PREPARED' if action == 'prepare' else 'DVA_APP_ROLLOUT_COMPLETE'
            print(marker + '=' + service)
'''


class AppDeliveryPipelineTests(unittest.TestCase):
    run_script = test_deploy.DeploymentTests.run_script
    calls = test_deploy.DeploymentTests.calls

    def setUp(self):
        test_deploy.DeploymentTests.setUp(self)
        self.env.update(RELEASE_NAME=test_deploy.RELEASE, MSA_SSH_KEY=str(self.key))
        (self.bin / 'ssh').write_text(test_deploy.FAKE + SSH_PEER)
        self.jenkins = (test_deploy.ROOT / 'msa/Jenkinsfile').read_text()
        for service in SERVICES:
            directory = self.root / 'msa/services' / service
            directory.mkdir(parents=True)
            (directory / 'k8s.yaml').write_text('image: docker.io/library/dva-' + service + ':RELEASE_TAG\n')
            self.run_script('deploy/package-app.sh', service)
        (self.root / 'msa-release/services.txt').write_text(''.join(s + '\n' for s in SERVICES))

    def stage(self, name, ok=True):
        block = re.search(r"stage\('" + re.escape(name) + r"'\).*?sh '''(.*?)'''", self.jenkins, re.S)
        self.assertIsNotNone(block, 'Missing Jenkins delivery stage: ' + name)
        result = subprocess.run(['bash', '-c', textwrap.dedent(block[1]).strip()],
                                cwd=self.root, env=self.env, text=True, capture_output=True, timeout=30)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def delivered(self, action):
        import shlex
        services = []
        for call in self.calls():
            if call[0] != 'ssh' or 'bash remote-app.sh' not in call[-1]:
                continue
            parts = shlex.split(call[-1])
            position = parts.index('remote-app.sh')
            if parts[position + 3] == action:
                services.append(parts[position + 1])
        return services

    def test_every_selected_service_is_prepared_then_applied(self):
        self.stage('Stage Application Images')
        self.assertEqual(self.delivered('prepare'), list(SERVICES))
        self.assertEqual(len([c for c in self.calls() if c[0] == 'scp']), len(SERVICES))
        self.stage('Application Delivery')
        self.assertEqual(self.delivered('apply'), list(SERVICES))
        self.assertEqual(len([c for c in self.calls() if c[0] == 'scp']), len(SERVICES))

    def test_prepare_failure_stops_before_later_services(self):
        self.env['FAIL_APP_SERVICE'] = 'consultation'
        self.stage('Stage Application Images', ok=False)
        self.assertEqual(self.delivered('prepare'), list(SERVICES[:3]))
        self.assertEqual(self.delivered('apply'), [])

    def test_apply_failure_propagates_through_tee_and_stops(self):
        self.env['FAIL_APP_SERVICE'] = 'consultation'
        self.stage('Application Delivery', ok=False)
        self.assertEqual(self.delivered('apply'), list(SERVICES[:3]))

    def test_missing_prepare_marker_is_not_success(self):
        self.env['MISSING_APP_MARKER'] = 'consultation'
        self.stage('Stage Application Images', ok=False)
        self.assertEqual(self.delivered('prepare'), list(SERVICES[:3]))

    def test_missing_apply_marker_is_not_success(self):
        self.env['MISSING_APP_MARKER'] = 'consultation'
        self.stage('Application Delivery', ok=False)
        self.assertEqual(self.delivered('apply'), list(SERVICES[:3]))

    def test_database_and_state_ssh_helpers_preserve_caller_input(self):
        self.run_script('deploy/package.sh')
        commands = [
            ['upload.sh', str(self.release), str(self.key)],
            ['run-remote.sh', test_deploy.RELEASE, 'order', 'preview', str(self.key)],
            ['read-app-state.sh', str(self.key)],
        ]
        for script, *args in commands:
            with self.subTest(script=script):
                result = subprocess.run(['bash', '-c',
                    'set -eu; bash "$@"; IFS= read -r remaining; test "$remaining" = sentinel',
                    '--', str(self.root / 'msa/deploy' / script), *args],
                    input='sentinel\n', cwd=self.root, env=self.env,
                    text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
