"""Disposable Git history shared by the current delivery/verification planners."""
from pathlib import Path
import subprocess
import tempfile


class GitFixture:
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
        try:
            return subprocess.run(['git', *args], cwd=self.root, check=True,
                                  capture_output=True, text=True).stdout.strip()
        except subprocess.CalledProcessError as error:
            error.add_note('Git fixture stderr\n' + error.stderr)
            raise

    def commit(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.git('add', '.')
        self.git('commit', '-qm', 'test')
