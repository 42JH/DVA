"""Regression checks for deployment history and resource recovery."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import test_changes

DEPLOY = Path(__file__).resolve().parents[1]

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), DEPLOY / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

planner = load('plan-apps')
release = load('app-release')


def deployment(commit):
    return {
        'apiVersion': 'apps/v1', 'kind': 'Deployment',
        'metadata': {'name': 'customer', 'namespace': 'dva', 'generation': 1,
                     'annotations': {'dva.ssafy.io/deployed-commit': commit}},
        'spec': {'replicas': 1, 'strategy': {'type': 'RollingUpdate', 'rollingUpdate': {'maxUnavailable': 0, 'maxSurge': 1}},
                 'template': {'spec': {'containers': [{'name': 'customer', 'image': 'old',
                     'readinessProbe': {'httpGet': {'path': '/customer/health'}}}]}}},
        'status': {'observedGeneration': 1, 'replicas': 1, 'updatedReplicas': 1,
                   'availableReplicas': 1, 'readyReplicas': 1},
    }


class DeliveryPlanTests(unittest.TestCase):
    git = test_changes.ChangeFilterTests.git
    commit = test_changes.ChangeFilterTests.commit

    def setUp(self):
        test_changes.ChangeFilterTests.setUp(self)
        original = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, original)
        self.commit('msa/services/customer/Dockerfile', 'FROM node')
        self.commit('msa/services/customer/k8s.yaml', 'manifest')
        self.commit('msa/liquibase/changelog/customer/001.sql', 'initial')
        self.deployed = self.git('rev-parse', 'HEAD')
        self.state = {'customer': deployment(self.deployed)}

    def test_new_order_service_does_not_rebuild_customer_or_database(self):
        self.commit('msa/services/order/Dockerfile', 'FROM node')
        self.commit('msa/services/order/k8s.yaml', 'manifest')
        annotations = {f'dva.ssafy.io/db-{name}-commit': self.deployed
                       for name in ('customer', 'operations', 'order', 'consultation', 'delivery')}
        self.assertEqual(planner.plan(self.deployed, True, self.state, annotations), ['order'])
        self.assertEqual(planner.databases(self.deployed, True, annotations), [])
        self.assertFalse(planner.changed(self.deployed, planner.DB_PATHS))
        order = deployment(self.git('rev-parse', 'HEAD'))
        order['metadata']['name'] = 'order'
        self.state['order'] = order
        self.assertEqual(planner.plan(self.deployed, True, self.state, annotations), [])

    def test_ci_success_does_not_hide_undeployed_change(self):
        self.commit('msa/services/customer/src/main.ts', 'new app')
        ci_success = self.git('rev-parse', 'HEAD')
        self.assertEqual(planner.plan(ci_success, True, self.state, {}), ['customer'])

    def test_unchanged_deployed_service_skips(self):
        self.commit('backend/other.ts', 'unrelated')
        self.assertEqual(planner.plan('', True, self.state, {}), [])

    def test_database_only_change_is_selected_without_app(self):
        annotations = {f'dva.ssafy.io/db-{name}-commit': self.deployed for name in ('customer', 'operations', 'order', 'consultation', 'delivery')}
        self.commit('msa/liquibase/changelog/operations/002.sql', 'schema only')
        self.assertEqual(planner.plan('', True, self.state, annotations), [])
        self.assertEqual(planner.databases(self.git('rev-parse', 'HEAD'), True, annotations), ['operations'])

    def test_database_retry_uses_apply_history_not_successful_ci(self):
        annotations = {f'dva.ssafy.io/db-{name}-commit': self.deployed for name in ('customer', 'operations', 'order', 'consultation', 'delivery')}
        self.commit('msa/liquibase/changelog/customer/002.sql', 'new schema')
        self.commit('msa/liquibase/changelog/order/002.sql', 'new schema')
        current = self.git('rev-parse', 'HEAD')
        self.assertEqual(planner.databases(current, True, annotations), ['customer', 'order'])
        annotations['dva.ssafy.io/db-customer-commit'] = current
        self.assertEqual(planner.databases(current, True, annotations), ['order'])
        annotations['dva.ssafy.io/db-order-commit'] = current
        self.assertEqual(planner.databases(current, True, annotations), [])

    def test_missing_database_history_checks_all_databases(self):
        self.assertEqual(planner.databases('', True, {}), ['customer', 'operations', 'order', 'consultation', 'delivery'])

    def test_legacy_image_bootstrap_only_when_ready(self):
        old = self.state['customer']
        old['metadata']['annotations'] = {}
        old['spec']['template']['spec']['containers'][0]['image'] = f'docker.io/library/dva-customer:{self.deployed}-12'
        self.assertEqual(planner.deployed_commit(old, 'customer'), self.deployed)
        old['status']['readyReplicas'] = 0
        self.assertEqual(planner.deployed_commit(old, 'customer'), '')

    def test_app_scripts_do_not_trigger_database_ci(self):
        self.commit('msa/deploy/remote-app.sh', 'app-only')
        self.assertFalse(planner.changed(self.deployed, planner.DB_PATHS))

    def test_invalid_state_fails_instead_of_empty_history(self):
        with self.assertRaises((ValueError, KeyError)):
            planner.read_state('{}')


class ReleaseRecoveryTests(unittest.TestCase):
    def test_kubectl_multiple_json_documents(self):
        first, second = {'kind': 'Deployment'}, {'kind': 'Service'}
        self.assertEqual(release.parse_resources(json.dumps(first) + '\n' + json.dumps(second)), [first, second])
        self.assertEqual(release.parse_resources(json.dumps({'kind': 'List', 'items': [first, second]})), [first, second])

    def test_digest_mismatch_and_duplicate_rejected(self):
        row = 'image application/vnd.oci.image.index.v1+json sha256:abc 1MiB linux/amd64\n'
        release.verify_digest(row, 'image', 'sha256:abc')
        for text, digest in [(row, 'sha256:wrong'), ('', 'sha256:abc'), (row + row, 'sha256:abc')]:
            with self.subTest(text=text, digest=digest), self.assertRaises(RuntimeError):
                release.verify_digest(text, 'image', digest)

    def test_failed_rollout_restores_resources_and_never_records_success(self):
        old = deployment('a' * 40)
        desired = copy.deepcopy(old)
        desired['spec']['template']['spec']['containers'][0]['image'] = 'new'
        service = {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'customer', 'namespace': 'dva'},
                   'spec': {'ports': [{'name': 'http', 'port': 3001}]}}
        calls = []
        def kube(*args, **kwargs):
            calls.append(args)
            if '--dry-run=server' in args:
                return json.dumps({'kind': 'List', 'items': [desired, service]})
            if 'get' in args:
                return json.dumps(desired if 'deployment' in args and '--ignore-not-found' not in args else old if 'deployment' in args else service)
            return ''
        with tempfile.TemporaryDirectory() as temp:
            original = Path.cwd()
            os.chdir(temp)
            try:
                with patch.object(release, 'kube', side_effect=kube), patch.object(release, 'rollout', side_effect=[RuntimeError('not ready'), None]), patch.object(release, 'probe') as probe:
                    with self.assertRaisesRegex(RuntimeError, 'not ready'):
                        release.apply_release('customer', 'b' * 40 + '-1', 'new')
                    self.assertIn(('apply', '-f', 'previous-resources.json'), calls)
                    self.assertFalse(any('annotate' in c for c in calls))
                    self.assertEqual(probe.call_count, 1)
                    snapshot = json.loads(Path('previous-resources.json').read_text())
                    self.assertEqual(snapshot['items'][0]['spec']['template']['spec']['containers'][0]['image'], 'old')
            finally:
                os.chdir(original)

    def test_foreign_resource_rejected_before_apply(self):
        dep = deployment('a' * 40)
        dep['metadata']['namespace'] = 'other'
        with self.assertRaises(RuntimeError):
            release.validate_resources([dep], 'customer', 'old')
