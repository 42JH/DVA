"""Later APIs must not replace the regression reference or modify the real backend."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import test_ci_images

spec = importlib.util.spec_from_file_location('ci_workspace', Path(__file__).resolve().parents[2] / 'parity/ci_workspace.py')
workspace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)


class CiWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        for folder in ('backend/src', 'msa/parity', 'msa/liquibase'):
            (self.root / folder).mkdir(parents=True)
        (self.root / 'backend/src/api.ts').write_text('original 055 contract\n')
        for name in ('application', 'orders', 'manual-orders'):
            path = self.root / 'backend/test/helpers' / (name + '.cjs')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('module.exports = "original fixture";\n')
        (self.root / 'msa/.gitignore').write_text('.ci-source/\nliquibase/verification-logs/\n')
        (self.root / 'msa/liquibase/Dockerfile').write_text('FROM liquibase/liquibase:5.0.4\n')
        (self.root / '.gitignore').write_text('msa-release/\n')
        self.commit()
        self.reference = self.git('rev-parse', 'HEAD')
        (self.root / 'msa/parity/baseline.json').write_text(json.dumps({'commit': self.reference}))
        (self.root / 'backend/src/api.ts').write_text('later 056 API, deliberately excluded\n')
        self.commit()
        self.source = self.git('rev-parse', 'HEAD')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True, stderr=subprocess.PIPE).strip()

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def test_snapshot_pins_only_reference_and_keeps_msa_and_real_backend(self):
        with patch.object(workspace, 'ROOT', self.root):
            snapshot = workspace.prepare()
        self.assertEqual((snapshot / 'backend/src/api.ts').read_text(), 'original 055 contract\n')
        self.assertIn('later 056', (self.root / 'backend/src/api.ts').read_text())
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.source)
        self.assertEqual(workspace.git(snapshot, 'rev-parse', 'HEAD:msa'), self.git('rev-parse', 'HEAD:msa'))
        self.assertEqual(self.git('diff', '--name-only'), '')
        self.assertTrue((snapshot / 'msa-release').is_symlink())
        (snapshot / 'msa/liquibase/verification.json').write_text('{"passed":true}')
        self.assertEqual((self.root / 'msa/liquibase/verification.json').read_text(), '{"passed":true}')
        with patch.object(test_ci_images.images, 'ROOT', snapshot), patch.dict(os.environ, MSA_CI_ORIGINAL_COMMIT=self.source):
            self.assertEqual(test_ci_images.images.source_commit(), self.source)

    def test_existing_snapshot_and_bad_pin_fail_without_overwriting(self):
        with patch.object(workspace, 'ROOT', self.root):
            workspace.prepare()
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                workspace.prepare()
        self.assertIn('later 056', (self.root / 'backend/src/api.ts').read_text())

    def test_bad_reference_is_rejected_before_snapshot_creation(self):
        (self.root / 'msa/parity/baseline.json').write_text(json.dumps({'commit': 'HEAD; invalid'}))
        self.commit()
        with patch.object(workspace, 'ROOT', self.root), self.assertRaises(ValueError):
            workspace.prepare()
        self.assertFalse((self.root / 'msa/.ci-source').exists())

    def fixture_patch(self, paths):
        for path in paths:
            (self.root / path).write_text('module.exports = "session fixture";\n')
        content = self.git('diff', '--unified=0', '--binary', '--full-index', '--', 'backend') + '\n'
        self.git('restore', '--', *paths)
        (self.root / 'msa/parity/reference-tests.patch').write_text(content)
        self.commit()
        self.source = self.git('rev-parse', 'HEAD')

    def test_test_fixture_cleanup_preserves_pinned_api_and_rejects_extra_changes(self):
        paths = ['backend/test/helpers/' + name + '.cjs' for name in ('application', 'orders', 'manual-orders')]
        self.fixture_patch(paths)
        with patch.object(workspace, 'ROOT', self.root):
            snapshot = workspace.prepare()
        self.assertEqual((snapshot / 'backend/src/api.ts').read_text(), 'original 055 contract\n')
        self.assertIn('later 056', (self.root / 'backend/src/api.ts').read_text())
        self.assertIn('session fixture', (snapshot / paths[0]).read_text())
        with patch.object(test_ci_images.images, 'ROOT', snapshot), patch.dict(os.environ, MSA_CI_ORIGINAL_COMMIT=self.source):
            self.assertEqual(test_ci_images.images.source_commit(), self.source)
            (snapshot / 'backend/src/api.ts').write_text('unexpected contract change\n')
            workspace.git(snapshot, 'add', 'backend/src/api.ts')
            workspace.git(snapshot, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--amend', '--no-edit')
            with self.assertRaisesRegex(RuntimeError, 'approved reference test fixtures'):
                test_ci_images.images.source_commit()

    def test_fixture_patch_cannot_change_api_or_test_expectations(self):
        self.fixture_patch(['backend/src/api.ts'])
        with patch.object(workspace, 'ROOT', self.root), self.assertRaisesRegex(RuntimeError, 'three business helpers'):
            workspace.prepare()
        self.assertIn('later 056', (self.root / 'backend/src/api.ts').read_text())


if __name__ == '__main__':
    unittest.main()
