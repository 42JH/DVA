"""Execute the DB delivery driver with controlled remote commands; no live database."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class DatabaseDeliveryTests(unittest.TestCase):
    def execute(self, mode):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / 'msa/deploy'
            scripts.mkdir(parents=True)
            shutil.copyfile(ROOT / 'msa/deploy/deliver-databases.sh', scripts / 'deliver-databases.sh')
            (root / 'msa-release').mkdir()
            (root / 'msa-release/databases.txt').write_text('customer\norder\n')
            (scripts / 'upload.sh').write_text('echo upload >> calls\n')
            (scripts / 'run-remote.sh').write_text("""set -eu
echo "$2 $3" >> calls
if [ "$3" = preview ]; then
  if [ "$MODE" != missing ]; then printf 'DVA_PENDING_SHA256=%064d\\n' 0; fi
else
  test "${#5}" = 64
  if [ "$MODE" = fail ]; then exit 1; fi
  echo "DVA_MIGRATION_COMPLETE=$2"
fi
""")
            result = subprocess.run(['bash', 'msa/deploy/deliver-databases.sh', 'test-key'], cwd=root,
                                    env=dict(os.environ, MODE=mode, RELEASE_NAME='a'*40+'-1'),
                                    capture_output=True, text=True, timeout=10)
            calls = (root / 'calls').read_text().splitlines()
            return result, calls

    def test_all_changed_databases_applied_in_order(self):
        result, calls = self.execute('success')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls, ['upload', 'customer preview', 'customer apply', 'order preview', 'order apply'])

    def test_failure_stops_remaining_databases(self):
        result, calls = self.execute('fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ['upload', 'customer preview', 'customer apply'])

    def test_missing_fingerprint_stops_before_update(self):
        result, calls = self.execute('missing')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ['upload', 'customer preview'])
