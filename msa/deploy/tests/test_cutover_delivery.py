"""Exercise the Jenkins-side DB delivery script without SSH or a real cluster."""
import os
import unittest
import test_deploy

FAKE_SSH = r'''
if name == 'ssh':
    import shlex
    parts=shlex.split(args[-1])
    if 'remote.sh' in parts:
        position=parts.index('remote.sh')
        if len(parts)<position+3: sys.exit(0)
        action,service=parts[position+1:position+3]
        state=pathlib.Path(os.environ['CUTOVER_STATE'])
        if action=='preview':
            if os.environ.get('BAD_PREVIEW')==service: print('DVA_PENDING_SHA256=invalid')
            else: print('DVA_PENDING_SHA256='+'b'*64)
            if os.environ.get('PARCEL_CUTOVER') and service in ('order','consultation'):
                print('DVA_QUIESCENT_CUTOVER_REQUIRED=055')
        elif action=='prepare-cutover':
            if os.environ.get('FAIL_PREPARE'): sys.exit(9)
            state.write_text('ready')
            print('DVA_QUIESCENT_CUTOVER_READY=055')
        elif action=='restore-cutover':
            print('DVA_QUIESCENT_CUTOVER_RESTORED=055')
        elif action=='apply':
            if os.environ.get('PARCEL_CUTOVER') and service in ('order','consultation') and not state.exists():
                print('055 requires stopped writers and backups',file=sys.stderr);sys.exit(6)
            if os.environ.get('FAIL_APPLY')==service: sys.exit(8)
            print('DVA_MIGRATION_COMPLETE='+service)
'''


class CutoverDeliveryTests(unittest.TestCase):
    run_script = test_deploy.DeploymentTests.run_script
    calls = test_deploy.DeploymentTests.calls

    def setUp(self):
        test_deploy.DeploymentTests.setUp(self)
        original = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, original)
        self.env['RELEASE_NAME'] = test_deploy.RELEASE
        self.env['CUTOVER_STATE'] = str(self.root / 'cutover-ready')
        (self.bin / 'ssh').write_text(test_deploy.FAKE + FAKE_SSH)
        self.run_script('deploy/package.sh')
        self.selected = self.root / 'msa-release/databases.txt'
        self.selected.write_text('order\nconsultation\n')
        self.env['PARCEL_CUTOVER'] = '1'

    def actions(self):
        import shlex
        values = []
        for call in self.calls():
            if call[0] != 'ssh':
                continue
            parts = shlex.split(call[-1])
            if 'remote.sh' in parts:
                index = parts.index('remote.sh')
                if len(parts) >= index + 3:
                    values.append(tuple(parts[index + 1:index + 3]))
        return values

    def test_055_prepares_once_after_all_previews_before_any_apply(self):
        self.run_script('deploy/deliver-databases.sh', self.key)
        self.assertEqual(self.actions(), [('preview', 'order'), ('preview', 'consultation'),
                         ('prepare-cutover', 'order'), ('apply', 'order'), ('apply', 'consultation')])

    def test_invalid_later_preview_never_applies_an_earlier_db(self):
        self.selected.write_text('customer\norder\nconsultation\n')
        self.env['BAD_PREVIEW'] = 'order'
        self.run_script('deploy/deliver-databases.sh', self.key, ok=False)
        self.assertFalse(any(action == 'apply' for action, _ in self.actions()))

    def test_preparation_failure_never_applies_db_changes(self):
        self.env['FAIL_PREPARE'] = '1'
        self.run_script('deploy/deliver-databases.sh', self.key, ok=False)
        self.assertFalse(any(action == 'apply' for action, _ in self.actions()))

    def test_partial_failure_attempts_only_fenced_recovery_and_stays_failed(self):
        self.env['FAIL_APPLY'] = 'consultation'
        self.run_script('deploy/deliver-databases.sh', self.key, ok=False)
        self.assertEqual(self.actions()[-1], ('restore-cutover', 'order'))

    def test_ordinary_migration_does_not_stop_apps(self):
        self.selected.write_text('customer\n')
        self.run_script('deploy/deliver-databases.sh', self.key)
        self.assertEqual(self.actions(), [('preview', 'customer'), ('apply', 'customer')])

    def test_055_requires_both_db_targets(self):
        self.selected.write_text('order\n')
        self.run_script('deploy/deliver-databases.sh', self.key, ok=False)
        self.assertFalse(any(action == 'apply' for action, _ in self.actions()))


if __name__ == '__main__':
    unittest.main()
