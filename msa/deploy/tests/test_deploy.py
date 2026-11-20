"""Offline contract tests. External commands are fakes; never contact a server."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
RELEASE = 'a' * 40 + '-17'
IMAGE = 'docker.io/library/dva-liquibase:' + RELEASE
IMAGE_ID = 'sha256:' + 'b' * 64

FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as f: f.write(json.dumps([name,*args])+'\n')
if name=='docker':
    if args[:2]==['image','inspect']: print(os.environ['FAKE_IMAGE_ID'])
    elif args[0]=='save': pathlib.Path(args[args.index('--output')+1]).write_text('image bytes')
    else: sys.exit(2)
elif name=='ssh':
    if os.environ.get('FAIL_MKDIR') and 'mkdir' in args[-1]: sys.exit(1)
elif name=='sudo':
    if 'create' in args:
        pathlib.Path(os.environ['MANIFEST']).write_text(sys.stdin.read())
    elif 'get' in args and any(x.startswith('job/') for x in args):
        print(',1' if os.environ.get('FAIL_JOB') else '1,')
    elif 'logs' in args: print('job log')
elif name=='liquibase':
    output=next((x.split('=',1)[1] for x in args if x.startswith('--output-file=')),None)
    if output:
        mode=os.environ.get('FAKE_STATUS','current')
        text={'current':'Database is up to date, no changesets to execute\n',
              'unknown':'unknown status format\n',
              'pending':'1 changesets have not been applied\n  dva/customer/db.changelog.xml::002-employee-no-and-status::dva\n',
              'parcel':'1 changesets have not been applied\n  dva/order/db.changelog.xml::004-parcel-drafts::dva\n',
              'intake':'1 changesets have not been applied\n  dva/consultation/db.changelog.xml::008-order-intake::dva\n'}[mode]
        pathlib.Path(output).write_text(text)
'''


class DeploymentTests(unittest.TestCase):
    def test_055_pending_preview_marks_the_quiescent_cutover_without_applying(self):
        for mode, service in [('parcel', 'order'), ('intake', 'consultation')]:
            with self.subTest(service=service):
                self.env['FAKE_STATUS'] = mode
                output = self.run_script('liquibase/ci-command.sh', service, 'preview').stdout
                self.assertIn('DVA_QUIESCENT_CUTOVER_REQUIRED=055', output)
                self.assertFalse(any('update' in call for call in self.calls() if call[0] == 'liquibase'))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        shutil.copytree(ROOT / 'msa/deploy', self.root / 'msa/deploy', ignore=shutil.ignore_patterns('__pycache__', 'tests'))
        (self.root / 'msa/liquibase/changelog').mkdir(parents=True)
        for name in ('run-service.sh', 'ci-command.sh'):
            shutil.copyfile(ROOT / 'msa/liquibase' / name, self.root / 'msa/liquibase' / name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('docker', 'ssh', 'scp', 'sudo', 'liquibase'):
            p = self.bin / name
            p.write_text(FAKE)
            p.chmod(0o755)
        self.log = self.root / 'calls.jsonl'
        self.key = self.root / 'private-test-key'
        self.key.write_text('test placeholder, not a credential')
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        SOURCE_COMMIT='a'*40, BUILD_NUMBER='17', DB_IMAGE=IMAGE,
                        MSA_SSH_HOST='ssh.example.test',
                        FAKE_IMAGE_ID=IMAGE_ID, CALL_LOG=str(self.log), MANIFEST=str(self.root/'job.yaml'))
        self.report = self.root / 'msa/liquibase/verification.json'
        self.report.write_text(json.dumps({'passed': True, 'image': IMAGE, 'imageId': IMAGE_ID}))
        self.release = self.root / 'msa-release' / RELEASE

    def run_script(self, script, *args, ok=True):
        result = subprocess.run(['bash', str(self.root / 'msa' / script), *map(str,args)],
                                env=self.env, text=True, capture_output=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def package(self):
        self.run_script('deploy/package.sh')

    def test_shell_syntax(self):
        for path in list((ROOT/'msa/deploy').glob('*.sh')) + list((ROOT/'msa/liquibase').glob('*.sh')):
            result = subprocess.run(['bash', '-n', str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, str(path) + result.stderr)

    def test_package_and_duplicate_release(self):
        self.package()
        self.assertEqual((self.release/'image-name.txt').read_text().strip(), IMAGE)
        self.assertEqual((self.release/'image-id.txt').read_text().strip(), IMAGE_ID)
        result = subprocess.run(['sha256sum','--check','SHA256SUMS'], cwd=self.release, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.run_script('deploy/package.sh', ok=False)

    def test_package_requires_successful_report(self):
        self.report.write_text(json.dumps({'passed': False, 'image': IMAGE, 'imageId': IMAGE_ID}))
        self.run_script('deploy/package.sh', ok=False)
        self.assertFalse(any(c[:2]==['docker','save'] for c in self.calls()))

    def test_changed_image_rejected(self):
        self.env['FAKE_IMAGE_ID'] = 'sha256:'+'c'*64
        self.run_script('deploy/package.sh', ok=False)
        self.assertFalse(self.release.exists())

    def test_upload_verifies_and_pins_host(self):
        self.package()
        self.run_script('deploy/upload.sh', self.release, self.key)
        calls = self.calls()
        ssh = [c for c in calls if c[0]=='ssh']
        self.assertEqual(len(ssh),2)
        self.assertTrue(all('StrictHostKeyChecking=yes' in c for c in ssh))
        self.assertIn('bash remote.sh prepare', ssh[-1][-1])
        scp = next(c for c in calls if c[0]=='scp')
        # Credential path is only the -i option, never one of the source files.
        self.assertNotIn(str(self.key), scp[scp.index('liquibase-image.tar'):])

    def test_corruption_stops_before_ssh(self):
        self.package()
        (self.release/'liquibase-image.tar').write_text('corrupted')
        self.run_script('deploy/upload.sh', self.release, self.key, ok=False)
        self.assertFalse(any(c[0] in ('ssh','scp') for c in self.calls()))

    def test_existing_remote_release_stops_copy(self):
        self.package()
        self.env['FAIL_MKDIR']='1'
        self.run_script('deploy/upload.sh', self.release, self.key, ok=False)
        self.assertFalse(any(c[0]=='scp' for c in self.calls()))

    def test_remote_arguments_reject_injection(self):
        self.run_script('deploy/run-remote.sh', RELEASE, 'customer;id', 'preview', self.key, ok=False)
        self.run_script('deploy/run-remote.sh', '../escape', 'customer', 'preview', self.key, ok=False)
        self.run_script('deploy/run-remote.sh', RELEASE, 'customer', 'apply', self.key, 'bad', ok=False)
        self.assertEqual(self.calls(), [])

    def test_job_manifest_and_success(self):
        self.run_script('liquibase/run-service.sh', 'customer', 'preview', IMAGE)
        manifest = (self.root/'job.yaml').read_text()
        self.assertIn('backoffLimit: 0', manifest)
        self.assertIn('automountServiceAccountToken: false', manifest)
        self.assertIn('name: customer-db', manifest)
        self.assertIn('value: "$(PGPASSWORD)"', manifest)
        self.assertIn('/liquibase/ci-command.sh', manifest)

    def test_failed_job_is_failure(self):
        self.env['FAIL_JOB']='1'
        self.run_script('liquibase/run-service.sh', 'customer', 'preview', IMAGE, ok=False)

    def test_unknown_status_is_not_success(self):
        self.env['FAKE_STATUS']='unknown'
        self.run_script('liquibase/ci-command.sh', 'customer', 'preview', ok=False)

    def test_mismatched_approval_does_not_update(self):
        self.env['FAKE_STATUS']='pending'
        self.run_script('liquibase/ci-command.sh', 'customer', 'apply', '0'*64, ok=False)
        self.assertFalse(any(c[0]=='liquibase' and 'update' in c for c in self.calls()))

    def test_successful_apply_requires_no_pending_changes(self):
        import hashlib
        fingerprint=hashlib.sha256(b'dva/customer/db.changelog.xml::002-employee-no-and-status::dva\n').hexdigest()
        self.env['FAKE_STATUS']='pending'
        result=self.run_script('liquibase/ci-command.sh', 'customer', 'apply', fingerprint, ok=False)
        self.assertIn('Unapplied changesets remain',result.stderr)


if __name__ == '__main__':
    unittest.main()
