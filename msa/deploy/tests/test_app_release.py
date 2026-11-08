"""Regression checks for deployment history and resource recovery."""
import copy
import base64
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

    def test_new_delivery_skips_deployed_customer_order_and_database(self):
        self.commit('msa/services/order/Dockerfile', 'FROM node')
        self.commit('msa/services/order/k8s.yaml', 'manifest')
        baseline = self.git('rev-parse', 'HEAD')
        order = deployment(baseline)
        order['metadata']['name'] = 'order'
        self.state['order'] = order
        annotations = {f'dva.ssafy.io/db-{name}-commit': baseline
                       for name in ('customer', 'operations', 'order', 'consultation', 'delivery')}
        self.commit('msa/services/delivery/Dockerfile', 'FROM node')
        self.commit('msa/services/delivery/k8s.yaml', 'manifest')
        self.assertEqual(planner.plan(baseline, True, self.state, annotations), ['delivery'])
        self.assertEqual(planner.databases(baseline, True, annotations), [])
        self.assertFalse(planner.changed(baseline, planner.DB_PATHS))
        delivery = deployment(self.git('rev-parse', 'HEAD'))
        delivery['metadata']['name'] = 'delivery'
        self.state['delivery'] = delivery
        self.assertEqual(planner.plan(baseline, True, self.state, annotations), [])

    def test_two_new_services_skip_existing_apps_and_retry_only_undeployed(self):
        for service in ('order', 'delivery'):
            self.commit(f'msa/services/{service}/Dockerfile', 'FROM node')
            self.commit(f'msa/services/{service}/k8s.yaml', 'manifest')
        baseline = self.git('rev-parse', 'HEAD')
        for service in ('customer', 'order', 'delivery'):
            self.state[service] = deployment(baseline)
            self.state[service]['metadata']['name'] = service
        annotations = {f'dva.ssafy.io/db-{name}-commit': baseline
                       for name in ('customer', 'operations', 'order', 'consultation', 'delivery')}
        for service in ('consultation', 'operations'):
            self.commit(f'msa/services/{service}/Dockerfile', 'FROM node')
            self.commit(f'msa/services/{service}/k8s.yaml', 'manifest')
        self.assertEqual(planner.plan(baseline, True, self.state, annotations),
                         ['operations', 'consultation'])
        self.assertEqual(planner.databases(baseline, True, annotations), [])
        self.assertFalse(planner.changed(baseline, planner.DB_PATHS))
        for service, remaining in [('operations', ['consultation']), ('consultation', [])]:
            self.state[service] = deployment(self.git('rev-parse', 'HEAD'))
            self.state[service]['metadata']['name'] = service
            self.assertEqual(planner.plan(baseline, True, self.state, annotations), remaining)

    def test_call_context_rolls_out_operations_then_customer_then_consultation(self):
        for service in ('operations', 'consultation'):
            self.commit(f'msa/services/{service}/Dockerfile', 'FROM node')
            self.commit(f'msa/services/{service}/k8s.yaml', 'manifest')
        self.commit('msa/services/customer/src/main.ts', 'context bridge')
        self.assertEqual(planner.plan(self.deployed, True, self.state, {}),
                         ['operations', 'customer', 'consultation'])

    def test_dependency_order_keeps_other_services_selected(self):
        self.commit('msa/services/analytics/Dockerfile', 'FROM node')
        self.commit('msa/services/analytics/k8s.yaml', 'manifest')
        self.assertEqual(planner.plan(self.deployed, True, self.state, {}), ['analytics'])

    def test_order_deploys_after_its_identity_call_and_shipment_owners(self):
        for service in ('order', 'consultation', 'operations', 'delivery'):
            self.commit(f'msa/services/{service}/Dockerfile', 'FROM node')
            self.commit(f'msa/services/{service}/k8s.yaml', 'manifest')
        self.commit('msa/services/customer/src/main.ts', 'order read scope')
        self.assertEqual(planner.plan(self.deployed, True, self.state, {}),
                         ['operations', 'customer', 'consultation', 'delivery', 'order'])

    def test_ci_success_does_not_hide_undeployed_change(self):
        self.commit('msa/services/customer/src/main.ts', 'new app')
        ci_success = self.git('rev-parse', 'HEAD')
        self.assertEqual(planner.plan(ci_success, True, self.state, {}), ['customer'])

    def test_shared_docker_context_change_rebuilds_service(self):
        self.commit('msa/.dockerignore', '**/node_modules')
        self.assertEqual(planner.plan(self.deployed, True, self.state, {}), ['customer'])

    def test_unchanged_deployed_service_skips(self):
        self.commit('backend/other.ts', 'unrelated')
        self.assertEqual(planner.plan('', True, self.state, {}), [])

    def test_parity_change_verifies_deployed_services_again(self):
        self.commit('msa/parity/operations-auth.test.cjs', 'updated contract check')
        self.assertEqual(planner.plan(self.deployed, True, self.state, {}), ['customer'])

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
    def test_first_055_failed_rollout_never_restores_the_legacy_app(self):
        old = deployment('a' * 40)
        old['metadata']['name'] = 'order'
        old['spec']['template']['spec']['containers'][0]['name'] = 'order'
        old['spec']['replicas'] = 0
        old['status'] = {'replicas': 0}
        desired = copy.deepcopy(old)
        desired['spec']['replicas'] = 1
        desired['spec']['template'].setdefault('metadata', {})['annotations'] = {'dva.ssafy.io/parcel-drafts-contract': '055'}
        desired['spec']['template']['spec']['containers'][0]['image'] = 'new'
        service = {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'order', 'namespace': 'dva'},
                   'spec': {'ports': [{'name': 'http', 'port': 3002}]}}
        calls = []
        def kube(*args, **kwargs):
            calls.append(args)
            if '--dry-run=server' in args:
                return json.dumps({'kind': 'List', 'items': [desired, service]})
            if 'namespace' in args:
                return json.dumps({'metadata': {'annotations': {'dva.ssafy.io/parcel-drafts-schema': '055'}}})
            if 'get' in args:
                return json.dumps(old if 'deployment' in args else service)
            return ''
        with tempfile.TemporaryDirectory() as temp:
            original = Path.cwd()
            os.chdir(temp)
            try:
                with patch.object(release, 'kube', side_effect=kube), patch.object(release, 'rollout', side_effect=RuntimeError('not ready')), patch.object(release, 'probe') as probe:
                    with self.assertRaisesRegex(RuntimeError, 'not ready'):
                        release.apply_release('order', 'b' * 40 + '-1', 'new')
                    self.assertNotIn(('apply', '-f', 'previous-resources.json'), calls)
                    self.assertFalse(any('annotate' in c for c in calls))
                    probe.assert_not_called()
            finally:
                os.chdir(original)

    def test_055_schema_rejects_old_order_and_consultation_candidates(self):
        namespace = {'metadata': {'annotations': {'dva.ssafy.io/parcel-drafts-schema': '055'}}}
        with patch.object(release, 'kube', return_value=json.dumps(namespace)):
            for service in ('order', 'consultation'):
                with self.subTest(service=service), self.assertRaisesRegex(RuntimeError, 'pre-parcel-draft'):
                    release.parcel_cutover(service, deployment('a'*40), None)

    def test_055_accepts_only_fully_stopped_cutover_and_compatible_new_app(self):
        candidate = deployment('a'*40)
        candidate['spec']['template'].setdefault('metadata', {})['annotations'] = {'dva.ssafy.io/parcel-drafts-contract': '055'}
        old = deployment('b'*40)
        old['spec']['replicas'] = 0
        old['status'] = {'replicas': 0}
        namespace = {'metadata': {'annotations': {'dva.ssafy.io/parcel-drafts-schema': '055'}}}
        with patch.object(release, 'kube', return_value=json.dumps(namespace)):
            self.assertTrue(release.parcel_cutover('order', candidate, old))
            old['status']['replicas'] = 1
            self.assertFalse(release.parcel_cutover('order', candidate, old))
            old['status']['replicas'] = 0
            old['spec']['replicas'] = 1
            self.assertFalse(release.parcel_cutover('order', candidate, old))

    def test_existing_055_pod_fences_rollback_even_without_namespace_annotation(self):
        old = deployment('b'*40)
        old['spec']['template'].setdefault('metadata', {})['annotations'] = {'dva.ssafy.io/parcel-drafts-contract': '055'}
        with patch.object(release, 'kube', return_value='{}'), self.assertRaisesRegex(RuntimeError, 'pre-parcel-draft'):
            release.parcel_cutover('order', deployment('a'*40), old)

    def test_manifest_hmac_secret_is_provisioned_before_any_rollout(self):
        desired=deployment('a'*40)
        desired['spec']['template']['spec']['containers'][0]['env']=[{'name':'SECURITY_LOG_HMAC_KEY','valueFrom':{'secretKeyRef':{'name':'msa-security-logs','key':'hmac-key'}}}]
        service={'apiVersion':'v1','kind':'Service','metadata':{'name':'customer','namespace':'dva'},'spec':{'ports':[{'name':'http','port':3001}]}}
        with patch.object(release,'kube',side_effect=[json.dumps({'kind':'List','items':[desired,service]}),RuntimeError('stop before rollout')]), patch.object(release,'ensure_service_auth_secret') as ensure:
            with self.assertRaisesRegex(RuntimeError,'stop before rollout'):
                release.apply_release('customer','b'*40+'-1','old')
            ensure.assert_called_once_with('security-logs')

    def test_security_hmac_key_is_created_once_and_invalid_values_are_never_replaced(self):
        with patch.object(release, 'kube', side_effect=['', 'created']) as kube:
            release.ensure_service_auth_secret('security-logs')
            value=json.loads(kube.call_args_list[1].kwargs['data'])
            token=value['stringData']['hmac-key']
            self.assertRegex(token,r'^[a-f0-9]{64}$')
            self.assertNotIn(token,' '.join(kube.call_args_list[1].args))
            self.assertEqual(value['metadata'],{'name':'msa-security-logs','namespace':'dva'})
        for token in [token,'private-invalid']:
            existing={'metadata':value['metadata'],'data':{'hmac-key':base64.b64encode(token.encode()).decode()}}
            with patch.object(release,'kube',return_value=json.dumps(existing)) as kube:
                if token=='private-invalid':
                    with self.assertRaisesRegex(RuntimeError,'not replaced') as raised:
                        release.ensure_service_auth_secret('security-logs')
                    self.assertNotIn(token,str(raised.exception))
                else:
                    release.ensure_service_auth_secret('security-logs')
                self.assertEqual(kube.call_count,1)

    def test_consultation_auth_secret_created_and_preserved(self):
        with patch.object(release, 'kube', side_effect=['', 'created']) as kube:
            release.ensure_service_auth_secret('consultation')
            call = kube.call_args_list[1]
            value = json.loads(call.kwargs['data'])
            token = value['stringData']['consultation-token']
            self.assertGreaterEqual(len(token), 32)
            self.assertNotIn(token, ' '.join(call.args))
            self.assertEqual(value['metadata'], {'name': 'msa-consultation-auth', 'namespace': 'dva'})
        existing = {'metadata': value['metadata'], 'data': {'consultation-token': base64.b64encode(token.encode()).decode()}}
        with patch.object(release, 'kube', return_value=json.dumps(existing)) as kube:
            release.ensure_service_auth_secret('consultation')
            self.assertEqual(kube.call_count, 1)

    def test_invalid_consultation_secret_is_never_replaced(self):
        existing = {'metadata': {'name': 'msa-consultation-auth', 'namespace': 'dva'},
                    'data': {'consultation-token': base64.b64encode(b'private-invalid-value').decode()}}
        with patch.object(release, 'kube', return_value=json.dumps(existing)) as kube:
            with self.assertRaisesRegex(RuntimeError, 'not replaced') as raised:
                release.ensure_service_auth_secret('consultation')
            self.assertNotIn('private-invalid-value', str(raised.exception))
            self.assertEqual(kube.call_count, 1)

    def test_service_secret_rejects_unknown_owners_before_access(self):
        with patch.object(release, 'kube') as kube:
            with self.assertRaises(ValueError):
                release.ensure_service_auth_secret('unknown')
            kube.assert_not_called()

    def test_customer_auth_secret_created_once_without_exposing_token_in_args(self):
        with patch.object(release, 'kube', side_effect=['', 'created']) as kube:
            release.ensure_service_auth_secret('customer')
            self.assertEqual(kube.call_count, 2)
            call = kube.call_args_list[1]
            self.assertEqual(call.args, ('create', '-f', '-'))
            value = json.loads(call.kwargs['data'])
            token = value['stringData']['customer-token']
            self.assertGreaterEqual(len(token), 32)
            self.assertNotIn(token, ' '.join(call.args))
            self.assertEqual(value['metadata'], {'name': 'msa-customer-auth', 'namespace': 'dva'})

    def test_existing_customer_auth_secret_is_preserved(self):
        value = {'metadata': {'name': 'msa-customer-auth', 'namespace': 'dva'},
                 'data': {'customer-token': base64.b64encode(b'c' * 48).decode()}}
        with patch.object(release, 'kube', return_value=json.dumps(value)) as kube:
            release.ensure_service_auth_secret('customer')
            self.assertEqual(kube.call_count, 1)

    def test_invalid_customer_auth_secret_is_not_replaced_or_printed(self):
        value = {'metadata': {'name': 'msa-customer-auth', 'namespace': 'dva'},
                 'data': {'customer-token': base64.b64encode(b'private-invalid-value').decode()}}
        with patch.object(release, 'kube', return_value=json.dumps(value)) as kube:
            with self.assertRaisesRegex(RuntimeError, 'not replaced') as raised:
                release.ensure_service_auth_secret('customer')
            self.assertNotIn('private-invalid-value', str(raised.exception))
            self.assertEqual(kube.call_count, 1)

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
