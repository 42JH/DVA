"""Exercise path filtering against real temporary Git history."""
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'has-msa-changes.sh'


class ChangeFilterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.commit('msa/file.sql', 'initial')
        self.base = self.git('rev-parse', 'HEAD')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.git('add', '.')
        self.git('commit', '-qm', 'test')

    def detect(self, baseline):
        return subprocess.run(['bash', str(SCRIPT), baseline], cwd=self.root,
                              check=True, capture_output=True, text=True).stdout.strip()

    def test_same_commit_skips(self):
        self.assertEqual(self.detect(self.base), 'false')

    def test_unrelated_change_skips(self):
        self.commit('backend/main.ts', 'new')
        self.assertEqual(self.detect(self.base), 'false')

    def test_msa_change_runs_even_with_later_unrelated_commit(self):
        self.commit('msa/file.sql', 'changed')
        self.commit('README.md', 'later')
        self.assertEqual(self.detect(self.base), 'true')

    def test_move_out_of_msa_runs(self):
        self.git('mv', 'msa/file.sql', 'moved.sql')
        self.git('commit', '-qm', 'move')
        self.assertEqual(self.detect(self.base), 'true')

    def test_missing_history_runs(self):
        for baseline in ('', '0' * 40, '--invalid'):
            with self.subTest(baseline=baseline):
                self.assertEqual(self.detect(baseline), 'true')

    def test_diverged_history_runs(self):
        self.commit('README.md', 'other branch')
        other = self.git('rev-parse', 'HEAD')
        self.git('checkout', '--detach', self.base)
        self.commit('backend/main.ts', 'different history')
        self.assertEqual(self.detect(other), 'true')
