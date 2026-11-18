"""Staging must verify the candidate without applying it or requiring the new schema."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import test_app_release

release = test_app_release.release
RELEASE = 'a' * 40 + '-8'
DIGEST = 'sha256:' + 'b' * 64


class AppPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        original = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, original)
        self.image = 'docker.io/library/dva-customer:' + RELEASE
        Path('image-name.txt').write_text(self.image)
        Path('image-id.txt').write_text(DIGEST)
        desired = test_app_release.deployment('a' * 40)
        desired['spec']['template']['spec']['containers'][0]['image'] = self.image
        self.resources = {'kind': 'List', 'items': [desired, {
            'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'namespace': 'dva', 'name': 'customer'},
        }]}
        self.commands = []

    def kube(self, *args, **kwargs):
        if 'nodes' in args:
            return json.dumps({'items': [{'status': {'nodeInfo': {'architecture': 'amd64', 'operatingSystem': 'linux'},
                'conditions': [{'type': 'Ready', 'status': 'True'}]}}]})
        if 'namespace' in args:
            return 'namespace/dva'
        self.assertIn('--dry-run=server', args)
        return json.dumps(self.resources)

    def command(self, args, *rest, **kwargs):
        self.commands.append(args)
        return self.image + ' media ' + DIGEST if args[-1] == 'ls' else ''

    def invoke(self, action):
        with patch.object(release, 'kube', self.kube), patch.object(release, 'run', self.command), \
                patch.object(release, 'apply_release') as apply, \
                patch.object(release.sys, 'argv', ['app-release.py', 'customer', RELEASE, action]):
            release.main()
        return apply

    def test_stage_imports_and_validates_without_applying(self):
        apply = self.invoke('prepare')
        apply.assert_not_called()
        self.assertEqual(len([args for args in self.commands if 'import' in args]), 1)
        prepared = json.loads(Path('prepared-image.json').read_text())
        self.assertEqual(prepared['digest'], DIGEST)
        self.assertIsNone(prepared['parcelDraftsContract'])

    def test_apply_reuses_prepared_image_without_second_import(self):
        self.invoke('prepare')
        self.commands.clear()
        apply = self.invoke('apply')
        apply.assert_called_once_with('customer', RELEASE, self.image)
        self.assertFalse(any('import' in args for args in self.commands))

    def test_changed_preparation_is_rejected_before_rollout(self):
        self.invoke('prepare')
        prepared = json.loads(Path('prepared-image.json').read_text())
        prepared['digest'] = 'sha256:' + 'c' * 64
        Path('prepared-image.json').write_text(json.dumps(prepared))
        with self.assertRaisesRegex(RuntimeError, 'preparation does not match'):
            self.invoke('apply')


if __name__ == '__main__':
    unittest.main()
