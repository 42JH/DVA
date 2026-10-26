"""Exercise path filtering against real temporary Git history."""
from pathlib import Path
import subprocess
import tempfile
import unittest
import shutil

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

    def detect(self, baseline, *paths):
        bash = shutil.which('bash')
        self.assertIsNotNone(bash, 'Bash executable not found')

        result = subprocess.run(
            [bash, str(SCRIPT), baseline, *paths],
            cwd=self.root,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            f'Bash: {bash}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}',
        )
        return result.stdout.strip()

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

    def test_customer_change_skips_database(self):
        self.commit('msa/services/customer/src/main.ts', 'changed')
        self.assertEqual(
            self.detect(self.base, 'msa/liquibase/'),
            'false',
        )

    def test_customer_change_runs_customer_only(self):
        self.commit('msa/services/customer/src/main.ts', 'changed')
        self.assertEqual(
            self.detect(self.base, 'msa/services/customer/'),
            'true',
        )
        self.assertEqual(
            self.detect(self.base, 'msa/services/order/'),
            'false',
        )

    def test_database_change_skips_customer(self):
        self.commit('msa/liquibase/changelog/customer/003.sql', 'changed')
        self.assertEqual(
            self.detect(self.base, 'msa/liquibase/'),
            'true',
        )
        self.assertEqual(
            self.detect(self.base, 'msa/services/customer/'),
            'false',
        )

    def test_service_file_removal_runs_customer(self):
        self.commit('msa/services/customer/src/old.ts', 'old')
        baseline = self.git('rev-parse', 'HEAD')
        self.git('rm', 'msa/services/customer/src/old.ts')
        self.git('commit', '-qm', 'remove')
        self.assertEqual(
            self.detect(baseline, 'msa/services/customer/'),
            'true',
        )

    def test_service_change_is_not_common(self):
        self.commit('msa/services/customer/src/main.ts', 'changed')
        self.assertEqual(
            self.detect(
                self.base,
                'msa/',
                ':(exclude)msa/services/**',
                ':(exclude)msa/liquibase/**',
            ),
            'false',
        )

    def test_pipeline_change_is_common(self):
        self.commit('msa/Jenkinsfile', 'changed')
        self.assertEqual(
            self.detect(
                self.base,
                'msa/',
                ':(exclude)msa/services/**',
                ':(exclude)msa/liquibase/**',
            ),
            'true',
        )
