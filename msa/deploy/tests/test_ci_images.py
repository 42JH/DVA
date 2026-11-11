"""CI image deduplication must preserve every runner's checks and image identity."""
import importlib.util
import ast
import json
import os
import re
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from git_fixture import GitFixture

PATH = Path(__file__).resolve().parents[2] / 'parity/ci_images.py'
spec = importlib.util.spec_from_file_location('ci_images', PATH)
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class CiImageTests(unittest.TestCase):
    def test_git_fixture_failures_include_the_original_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = GitFixture()
            fixture.root = Path(directory)
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                fixture.git('--invalid-fixture-command')
            self.assertIn('invalid-fixture-command', failure.exception.stderr)
            self.assertIn('Git fixture stderr\n' + failure.exception.stderr, failure.exception.__notes__)

    def test_operations_keeps_all_contract_tests_and_excludes_only_source_performance_tests(self):
        root = PATH.parents[2]
        tree = ast.parse((root / 'msa/parity/verify-operations.py').read_text())
        commands = []
        for call in ast.walk(tree):
            if not isinstance(call, ast.Call):
                continue
            for keyword in call.keywords:
                if keyword.arg != 'command' or not isinstance(keyword.value, ast.Tuple):
                    continue
                if any(isinstance(item, ast.Constant) and item.value == 'test/ai-settings.integration.test.cjs'
                       for item in keyword.value.elts):
                    commands.append(ast.literal_eval(keyword.value))
        self.assertEqual(len(commands), 1)
        command = commands[0]
        self.assertEqual(command[:3], ('node', '--test', '--test-concurrency=1'))
        self.assertEqual(command[4:], ('test/ai-settings.test.cjs', 'test/ai-settings.integration.test.cjs'))
        self.assertTrue(command[3].startswith('--test-skip-pattern='))
        pattern = command[3].split('=', 1)[1]
        source = (root / 'backend/test/ai-settings.test.cjs').read_text()
        names = re.findall(r"^test\('([^']+)'", source, re.M)
        self.assertEqual([name for name in names if re.search(pattern, name)], [
            'shared option reads isolate callers, expire on settlement and separate rotated credentials',
            'health shares only the upstream probe and checks each caller database independently',
        ])

    def test_all_suites_share_eleven_images(self):
        wanted = images.required(list(images.SUITES), list(images.SERVICES), True)
        self.assertEqual(len(wanted), 11)
        for dependencies in images.SUITES.values():
            self.assertTrue(set(dependencies).issubset(wanted))
        self.assertTrue({s + '-checks' for s in images.SERVICES if s != 'delivery'}.issubset(wanted))
        self.assertNotIn('monolith-checks', wanted)

    def test_customer_keeps_reference_runtime_and_its_own_checks(self):
        self.assertEqual(set(images.required(['customer'], [], False)), set(images.SUITES['customer']))
        self.assertEqual(images.required([], ['delivery'], False), ['delivery'])
        with self.assertRaises(ValueError):
            images.required(['unknown'], [], False)

    def test_deployment_retry_builds_only_production_and_required_database_images(self):
        wanted = images.required([], list(images.SERVICES), True)
        self.assertEqual(set(wanted), {*images.SERVICES, 'liquibase'})
        self.assertEqual(images.required([], [], False), [])

    def test_context_keeps_msa_events_and_original_backend(self):
        self.assertEqual(images.context('customer-checks')[:2], ['--target', 'checks'])
        self.assertEqual(images.context('customer')[-1], str(images.ROOT / 'msa'))
        self.assertEqual(images.context('monolith')[-1], str(images.ROOT / 'backend'))
        for retired in ('monolith-checks', 'delivery-checks'):
            with self.assertRaises(ValueError):
                images.context(retired)

    def test_standalone_runner_still_builds_its_own_images(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(images.prepared_image('customer'))

    def test_reuse_rejects_stale_source_and_replaced_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'images.json'
            image_id = 'sha256:' + 'b' * 64
            data = {'commit': 'a' * 40, 'referenceTree': 'd' * 40, 'release': 'a' * 40 + '-1', 'images': {'customer': {'id': image_id}}}
            path.write_text(json.dumps(data))
            with patch.dict(os.environ, MSA_CI_IMAGES=str(path), MSA_CI_ORIGINAL_COMMIT=''), patch.object(images.subprocess, 'run'):
                with patch.object(images, 'run', return_value='c' * 40):
                    with self.assertRaisesRegex(RuntimeError, 'source commit'):
                        images.prepared_image('customer')
                actual = {'Id': image_id, 'Config': {'Labels': {'dva.ci-run': 'other'}}}
                with patch.object(images, 'run', side_effect=['a' * 40, 'd' * 40, json.dumps([actual])]):
                    with self.assertRaisesRegex(RuntimeError, 'ownership'):
                        images.prepared_image('customer')
                actual['Config']['Labels']['dva.ci-run'] = data['release']
                with patch.object(images, 'run', side_effect=['a' * 40, 'd' * 40, json.dumps([actual])]):
                    self.assertEqual(images.prepared_image('customer'), image_id)

    def test_cleanup_removes_only_its_checks_and_release_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'images.json'
            release = 'a' * 40 + '-1'
            image_id = 'sha256:' + 'b' * 64
            path.write_text(json.dumps({'release': release, 'images': {'customer': {'tag': 'ci-customer', 'id': image_id}}}))
            actual = json.dumps([{'Id': image_id, 'Config': {'Labels': {'dva.ci-run': release}}}])
            with patch.object(images, 'MANIFEST', path), patch.dict(os.environ, RELEASE_NAME=release), \
                    patch.object(images, 'run', side_effect=['id', actual, 'id', actual]), \
                    patch.object(images.subprocess, 'run') as remove:
                images.cleanup()
            tags = [call.args[0][-1] for call in remove.call_args_list]
            self.assertEqual(tags, ['ci-customer', 'docker.io/library/dva-customer:' + release])

    def test_cleanup_refuses_another_runs_image(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'images.json'
            release = 'a' * 40 + '-1'
            path.write_text(json.dumps({'release': release, 'images': {'customer': {'tag': 'ci-customer'}}}))
            actual = json.dumps([{'Config': {'Labels': {'dva.ci-run': 'another-run'}}}])
            with patch.object(images, 'MANIFEST', path), patch.dict(os.environ, RELEASE_NAME=release), \
                    patch.object(images, 'run', side_effect=['id', actual]), \
                    patch.object(images.subprocess, 'run') as remove:
                with self.assertRaisesRegex(RuntimeError, 'unowned'):
                    images.cleanup()
                remove.assert_not_called()


if __name__ == '__main__':
    unittest.main()
