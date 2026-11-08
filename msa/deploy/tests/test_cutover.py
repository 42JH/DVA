"""A 055 transition cannot trade data safety for a successful Jenkins result."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).resolve().parents[1] / 'prepare-cutover.py')
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)
RELEASE = 'a' * 40 + '-7'


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.events = []
        self.fenced = False
        self.replicas = {'order': 2, 'consultation': 1}
        self.pods = []
        self.databases = {s: 'dva_' + s for s in cutover.SERVICES}
        self.staged = cutover.staged
        self.patch(cutover, 'ROOT', self.directory)
        self.patch(cutover, 'kube', self.kube)
        self.patch(cutover, 'database', lambda service: self.databases[service])
        self.patch(cutover, 'pg', self.pg)
        self.patch(cutover, 'backup', self.backup)
        self.patch(cutover, 'staged', lambda _: None)

    def patch(self, target, name, value):
        item = patch.object(target, name, value)
        item.start()
        self.addCleanup(item.stop)

    def kube(self, *args, **kwargs):
        if 'deployment' in args and 'get' in args:
            return json.dumps({'items': [{'metadata': {'name': s, 'uid': 'uid-' + s},
                                         'spec': {'replicas': n, 'template': {'spec': {'containers': [{'name': s, 'image': 'old-' + s}]}}},
                                         'status': {'replicas': n}}
                                         for s, n in self.replicas.items()]})
        if 'pods' in args:
            return json.dumps({'items': self.pods})
        if 'namespace' in args:
            return json.dumps({'metadata': {'annotations': {'dva.ssafy.io/parcel-drafts-schema': '055'} if self.fenced else {}}})
        if 'scale' in args:
            service = next(s for s in cutover.OWNERS if 'deployment/' + s in args)
            self.replicas[service] = int(args[-1].split('=')[1])
            self.events.append(('scale', service, self.replicas[service]))
            return ''
        raise AssertionError(args)

    def pg(self, database, statement):
        self.events.append(('query', database))
        if statement == cutover.OUTBOX_SQL:
            return 't'
        return '0|0' if statement == cutover.CALL_SQL else '0'

    def backup(self, database, path):
        self.events.append(('backup', database))
        self.assertFalse(any(self.replicas.values()))
        with path.open('xb') as output:
            output.write(b'test dump')
        os.chmod(path, 0o600)
        import hashlib
        return hashlib.sha256(b'test dump').hexdigest()

    def test_prepares_and_verifies_same_stopped_epoch(self):
        cutover.prepare(RELEASE)
        cutover.verify(RELEASE)
        self.assertEqual(self.replicas, {'order': 0, 'consultation': 0})
        first_backup = next(i for i, e in enumerate(self.events) if e[0] == 'backup')
        self.assertEqual(len([e for e in self.events[:first_backup] if e[0] == 'scale']), 2)
        self.assertEqual(len([e for e in self.events if e[0] == 'backup']), 2)
        state = self.directory / 'backups' / RELEASE / 'ready.json'
        self.assertTrue(state.exists())
        self.assertEqual(state.stat().st_mode & 0o077, 0)

    def test_pending_event_never_stops_writers(self):
        self.patch(cutover, 'pg', lambda db, sql: 't' if sql == cutover.OUTBOX_SQL else '1')
        with self.assertRaisesRegex(RuntimeError, 'pending service events'):
            cutover.prepare(RELEASE)
        self.assertFalse(any(e[0] == 'scale' for e in self.events))

    def test_active_call_or_pending_pbx_never_stops_writers(self):
        for value in ('1|0', '0|1'):
            with self.subTest(value=value), patch.object(cutover, 'pg', side_effect=lambda db, sql: 't' if sql == cutover.OUTBOX_SQL else value if sql == cutover.CALL_SQL else '0'):
                with self.assertRaisesRegex(RuntimeError, 'active calls'):
                    cutover.prepare(RELEASE)
        self.assertFalse(any(e[0] == 'scale' for e in self.events))

    def test_backup_failure_restores_original_replica_counts(self):
        self.patch(cutover, 'backup', lambda *_: (_ for _ in ()).throw(RuntimeError('backup failed')))
        with self.assertRaisesRegex(RuntimeError, 'backup failed'):
            cutover.prepare(RELEASE)
        self.assertEqual(self.replicas, {'order': 2, 'consultation': 1})
        self.assertFalse((self.directory / 'backups' / RELEASE / 'ready.json').exists())

    def test_late_event_is_not_hidden_in_a_snapshot(self):
        count = 0
        def quiet(_):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError('late event')
        self.patch(cutover, 'quiet', quiet)
        with self.assertRaisesRegex(RuntimeError, 'late event'):
            cutover.prepare(RELEASE)
        self.assertEqual(self.replicas, {'order': 2, 'consultation': 1})
        self.assertFalse(any(e[0] == 'backup' for e in self.events))

    def test_terminating_pods_block_backup_and_restore_before_ddl(self):
        self.pods = [{'metadata': {'deletionTimestamp': 'now'}}]
        with patch.object(cutover.time, 'monotonic', side_effect=[0, 121]):
            with self.assertRaisesRegex(RuntimeError, 'did not stop'):
                cutover.prepare(RELEASE)
        self.assertEqual(self.replicas, {'order': 2, 'consultation': 1})
        self.assertFalse(any(e[0] == 'backup' for e in self.events))

    def test_tampered_backup_or_restarted_writer_blocks_ddl(self):
        cutover.prepare(RELEASE)
        dump = self.directory / 'backups' / RELEASE / 'order.dump'
        dump.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            cutover.verify(RELEASE)
        self.replicas['order'] = 1
        with self.assertRaisesRegex(RuntimeError, 'stopped writers'):
            cutover.verify(RELEASE)

    def test_changed_db_configuration_blocks_ddl(self):
        cutover.prepare(RELEASE)
        self.databases['order'] = 'other_order'
        with self.assertRaisesRegex(RuntimeError, 'configuration changed'):
            cutover.verify(RELEASE)

    def test_restore_never_resumes_legacy_apps_after_ddl_fence(self):
        cutover.prepare(RELEASE)
        self.fenced = True
        with self.assertRaisesRegex(RuntimeError, 'DDL fence'):
            cutover.restore(RELEASE)
        self.assertEqual(self.replicas, {'order': 0, 'consultation': 0})
        self.fenced = False
        cutover.restore(RELEASE)
        self.assertEqual(self.replicas, {'order': 2, 'consultation': 1})

    def test_overwrite_or_path_injection_is_rejected(self):
        with self.assertRaises(ValueError):
            cutover.prepare('../escape')
        cutover.prepare(RELEASE)
        with self.assertRaisesRegex(RuntimeError, 'already exists'):
            cutover.prepare(RELEASE)

    def test_unstaged_apps_are_rejected_before_any_writer_stops(self):
        self.patch(cutover, 'staged', self.staged)
        with self.assertRaises(FileNotFoundError):
            cutover.prepare(RELEASE)
        self.assertFalse(any(e[0] == 'scale' for e in self.events))

    def test_stage_requires_055_contract_and_verified_package(self):
        import hashlib
        for service in cutover.OWNERS:
            path = self.directory / 'apps' / RELEASE / service
            path.mkdir(parents=True)
            digest = 'sha256:' + 'b' * 64
            (path / 'image-id.txt').write_text(digest)
            (path / 'SHA256SUMS').write_text(hashlib.sha256(digest.encode()).hexdigest() + '  image-id.txt\n')
            (path / 'prepared-image.json').write_text(json.dumps({
                'release': RELEASE, 'image': f'docker.io/library/dva-{service}:{RELEASE}',
                'digest': digest, 'parcelDraftsContract': '055',
            }))
        self.staged(RELEASE)
        path = self.directory / 'apps' / RELEASE / 'order' / 'prepared-image.json'
        doc = json.loads(path.read_text())
        doc['parcelDraftsContract'] = None
        path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(RuntimeError, 'compatible 055'):
            self.staged(RELEASE)

    def test_fresh_empty_databases_work_without_prior_app_deployments(self):
        self.replicas = {}
        self.patch(cutover, 'pg', lambda db, sql: 'f' if sql == cutover.OUTBOX_SQL else '0')
        cutover.prepare(RELEASE)
        cutover.verify(RELEASE)
        self.assertFalse(any(e[0] == 'scale' for e in self.events))
        self.assertEqual(len([e for e in self.events if e[0] == 'backup']), 2)


if __name__ == '__main__':
    unittest.main()
