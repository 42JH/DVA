"""CI image deduplication must preserve every runner's checks and image identity."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / 'parity/ci_images.py'
spec = importlib.util.spec_from_file_location('ci_images', PATH)
images = importlib.util.module_from_spec(spec)
spec.loader.exec_module(images)


class CiImageTests(unittest.TestCase):
    def test_all_suites_share_thirteen_images(self):
        wanted = images.required(list(images.SUITES), list(images.SERVICES), True)
        self.assertEqual(len(wanted), 13)
        for dependencies in images.SUITES.values():
            self.assertTrue(set(dependencies).issubset(wanted))
        self.assertTrue({s + '-checks' for s in images.SERVICES}.issubset(wanted))

    def test_customer_keeps_monolith_checks_and_runtime(self):
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
        self.assertEqual(images.context('monolith-checks')[-1], str(images.ROOT / 'backend'))

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
