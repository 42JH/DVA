"""Real Git histories distinguish passed checks from pending deployments."""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import test_app_release
import ci_verification as verification
import ci_images as images


planner = test_app_release.planner


class VerificationHistoryTests(unittest.TestCase):
    git = test_app_release.DeliveryPlanTests.git
    commit = test_app_release.DeliveryPlanTests.commit

    def setUp(self):
        test_app_release.DeliveryPlanTests.setUp(self)
        for service in ('operations', 'consultation', 'delivery', 'order'):
            self.commit(f'msa/services/{service}/Dockerfile', 'FROM node')
            self.commit(f'msa/services/{service}/k8s.yaml', 'manifest')
        self.deployed = self.git('rev-parse', 'HEAD')
        self.state = {}
        for service in planner.SUITE_DEPENDENCIES['order']:
            value = test_app_release.deployment(self.deployed)
            value['metadata']['name'] = service
            self.state[service] = value
        self.annotations = {f'dva.ssafy.io/db-{s}-commit': self.deployed for s in self.state}
        self.out = Path('msa-release')
        self.out.mkdir()

    def history(self, commit, scopes=verification.SCOPES):
        (self.out / 'verification-history.json').write_text(json.dumps({s: commit + ':42' for s in scopes}))

    def selection(self, fallback=None):
        (self.out / 'cluster-state.json').write_text(json.dumps({'items': list(self.state.values())}) + '\n' +
            json.dumps({'metadata': {'name': 'dva', 'annotations': self.annotations}}))
        with patch.dict(os.environ, DELIVER_APPS='true', MSA_BASE_COMMIT=fallback or self.deployed):
            planner.main()
        return json.loads((self.out / 'verification-plan.json').read_text())

    def test_pending_055_rollout_does_not_repeat_already_passed_checks(self):
        self.commit('msa/liquibase/changelog/order/004-parcel-drafts.sql', '055 migration')
        passed = self.git('rev-parse', 'HEAD')
        self.history(passed)
        self.commit('msa/deploy/upload-app.sh', 'detach SSH input')
        result = self.selection()
        self.assertFalse(result['database'])
        self.assertFalse(result['events'])
        self.assertTrue(result['deployment'])
        self.assertEqual(result['paritySuites'], [])
        self.assertEqual(set((self.out / 'databases.txt').read_text().split()), {'order', 'consultation'})
        self.assertTrue({'order', 'consultation'}.issubset((self.out / 'services.txt').read_text().split()))

    def test_deployment_failure_does_not_repeat_an_unmodified_service_suite(self):
        self.commit('msa/services/customer/src/main.ts', 'new customer behavior')
        passed = self.git('rev-parse', 'HEAD')
        self.history(passed)
        result = self.selection()
        self.assertEqual(result['paritySuites'], [])
        self.assertIn('customer', (self.out / 'services.txt').read_text().split())

    def test_changed_customer_keeps_every_dependent_regression(self):
        self.history(self.deployed)
        self.commit('msa/services/customer/src/main.ts', 'new behavior after verification')
        self.assertEqual(self.selection()['paritySuites'], ['customer', 'consultation', 'order'])

    def test_changed_migration_or_verifier_requires_fresh_database_check(self):
        for filename in ('msa/liquibase/changelog/order/005.sql', 'msa/liquibase/Dockerfile',
                         'msa/liquibase/verify.py', 'msa/liquibase/ci-command.sh',
                         'msa/parity/ci_verification.py', 'msa/parity/ci_workspace.py',
                         'msa/parity/ci_images.py', 'msa/deploy/plan-apps.py',
                         'msa/parity/reference-tests.patch'):
            with self.subTest(filename=filename):
                self.history(self.git('rev-parse', 'HEAD'))
                self.commit(filename, 'changed execution input')
                self.assertTrue(self.selection()['database'])

    def test_database_documentation_does_not_repeat_integration(self):
        self.history(self.deployed)
        self.commit('msa/liquibase/README.md', 'documentation only')
        self.assertFalse(self.selection()['database'])

    def test_reference_code_change_reuses_database_proof_but_keeps_the_api_matrix(self):
        baseline = {'commit': '1' * 40, 'inventory': {'migrations': [
            {'file': 'backend/migrations/001-bootstrap.sql', 'sha256': 'a' * 64}]}}
        self.commit('msa/parity/baseline.json', json.dumps(baseline))
        passed = self.git('rev-parse', 'HEAD')
        self.history(passed)
        baseline['commit'] = '2' * 40
        self.commit('msa/parity/baseline.json', json.dumps(baseline))
        result = self.selection()
        self.assertFalse(result['database'])
        self.assertEqual(result['paritySuites'], ['operations', 'customer', 'consultation', 'order'])
        self.assertTrue(result['events'])
        self.assertTrue(result['deployment'])
        image_id = 'sha256:' + 'b' * 64
        with patch.object(verification, 'ROOT', self.root), \
                patch.object(images, 'prepared_image', return_value=image_id), \
                patch.object(images, 'source_commit', return_value=self.git('rev-parse', 'HEAD')), \
                patch.dict(os.environ, DB_IMAGE='verified-image'):
            verification.reuse_database()
        report = json.loads((self.root / 'msa/liquibase/verification.json').read_text())
        self.assertTrue(report['passed'])
        self.assertEqual(report['verificationOrigin']['commit'], passed)
        self.assertEqual(report['verificationOrigin']['build'], 42)
        self.assertEqual(report['imageId'], image_id)

    def test_changed_or_invalid_source_migrations_never_reuse_database_proof(self):
        migration = {'file': 'backend/migrations/001-bootstrap.sql', 'sha256': 'a' * 64}
        baseline = {'commit': '1' * 40, 'inventory': {'migrations': [migration]}}
        self.commit('msa/parity/baseline.json', json.dumps(baseline))
        self.history(self.git('rev-parse', 'HEAD'))
        candidates = [
            {'commit': '2' * 40, 'inventory': {'migrations': [{**migration, 'sha256': 'b' * 64}]}},
            {'commit': '2' * 40, 'inventory': {'migrations': [migration,
                {'file': 'backend/migrations/002-next.sql', 'sha256': 'b' * 64}]}},
            {'commit': '2' * 40, 'inventory': {'migrations': [{**migration, 'file': 'backend/migrations/002-renamed.sql'}]}},
            {}, {'commit': 'invalid', 'inventory': {'migrations': [migration]}},
            {'commit': '2' * 40, 'inventory': {'migrations': []}},
            {'commit': '2' * 40, 'inventory': {'migrations': [migration, migration]}},
            {'commit': '2' * 40, 'inventory': {'migrations': [{**migration, 'sha256': 'invalid'}]}},
            {'commit': '2' * 40, 'inventory': {'migrations': [{**migration, 'file': '../private.sql'}]}},
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                self.commit('msa/parity/baseline.json', json.dumps(candidate))
                self.assertTrue(self.selection()['database'])
                with patch.object(verification, 'ROOT', self.root), \
                        self.assertRaisesRegex(RuntimeError, 'fresh verification'):
                    verification.reuse_database()

    def test_invalid_previous_source_inventory_cannot_establish_a_reusable_proof(self):
        self.commit('msa/parity/baseline.json', 'invalid JSON')
        self.history(self.git('rev-parse', 'HEAD'))
        self.commit('msa/parity/baseline.json', json.dumps({'commit': '2' * 40,
            'inventory': {'migrations': [{'file': 'backend/migrations/001-bootstrap.sql', 'sha256': 'a' * 64}]}}))
        self.assertTrue(self.selection()['database'])

    def test_event_test_change_selects_event_checks_without_business_matrix(self):
        self.history(self.deployed)
        self.commit('msa/shared/events/test/unit.test.cjs', 'new event assertion')
        result = self.selection()
        self.assertTrue(result['events'])
        self.assertFalse(result['database'])
        self.assertEqual(result['paritySuites'], [])

    def test_order_shared_checker_helpers_select_only_the_order_suite(self):
        self.history(self.deployed)
        self.commit('msa/parity/final-parity.cjs', 'changed order schema and response helpers')
        result = self.selection()
        self.assertFalse(result['events'])
        self.assertFalse(result['database'])
        self.assertEqual(result['paritySuites'], ['order'])
        self.assertEqual((self.out / 'services.txt').read_text(), '')

    def test_service_documentation_does_not_rebuild_or_retest_runtime(self):
        self.history(self.deployed)
        self.commit('msa/services/customer/README.md', 'updated docs')
        result = self.selection()
        self.assertEqual(result['paritySuites'], [])
        self.assertEqual((self.out / 'services.txt').read_text(), '')

    def test_fixture_reset_change_keeps_every_consumer_suite(self):
        self.history(self.deployed)
        self.commit('msa/parity/fixture-reset.cjs', 'changed table reset')
        self.assertEqual(self.selection()['paritySuites'], ['operations', 'customer', 'consultation', 'order'])

    def test_fixture_lock_integration_change_selects_only_its_runner(self):
        self.history(self.deployed)
        self.commit('msa/parity/fixture-reset.integration.test.cjs', 'changed lock contention check')
        self.assertEqual(self.selection()['paritySuites'], ['operations'])

    def test_fixture_unit_change_stays_in_the_always_run_contract_stage(self):
        self.history(self.deployed)
        self.commit('msa/parity/fixture-reset.test.cjs', 'changed cheap unit assertion')
        self.assertEqual(self.selection()['paritySuites'], [])

    def test_invalid_or_missing_history_never_skips_changed_inputs(self):
        self.commit('msa/liquibase/verify.py', 'changed verifier')
        for value in ({}, {'database': '0' * 40 + ':42'}, {'database': '--invalid'},
                      {'database': None}, ['invalid'], 'invalid JSON'):
            with self.subTest(value=value):
                (self.out / 'verification-history.json').write_text(value if isinstance(value, str) else json.dumps(value))
                self.assertTrue(self.selection()['database'])

    def test_diverged_success_history_uses_the_current_branch_fallback(self):
        self.git('checkout', '-qb', 'verified-on-another-branch')
        self.commit('docs/other.md', 'a different branch')
        unrelated = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '--detach', self.deployed)
        self.commit('msa/services/customer/src/main.ts', 'changed current behavior')
        self.history(unrelated)
        origin = verification.previous('customer', self.deployed, Path.cwd())
        self.assertEqual(origin, {'commit': self.deployed, 'build': None})
        self.assertEqual(self.selection()['paritySuites'], ['customer', 'consultation', 'order'])

    def test_reused_database_report_requires_identical_inputs_and_current_image(self):
        self.history(self.deployed)
        image_id = 'sha256:' + 'b' * 64
        with patch.object(verification, 'ROOT', self.root), \
                patch.object(images, 'prepared_image', return_value=image_id), \
                patch.object(images, 'source_commit', return_value=self.deployed), \
                patch.dict(os.environ, DB_IMAGE='verified-image'):
            verification.reuse_database()
            report = json.loads((self.root / 'msa/liquibase/verification.json').read_text())
            self.assertTrue(report['passed'])
            self.assertEqual(report['imageId'], image_id)
            self.assertEqual(report['verificationOrigin']['commit'], self.deployed)
            self.assertEqual(report['verificationOrigin']['build'], 42)
            self.commit('msa/liquibase/verify.py', 'new checker')
            with self.assertRaisesRegex(RuntimeError, 'fresh verification'):
                verification.reuse_database()

    def test_failed_report_never_creates_a_success_stamp(self):
        target = self.root / 'msa/liquibase/verification.json'
        target.write_text('{"passed":false}')
        with patch.object(verification, 'ROOT', self.root), self.assertRaisesRegex(RuntimeError, 'unsuccessful'):
            verification.record('database')
        self.assertFalse((self.out / 'verified-database.txt').exists())

    def test_database_success_stamp_is_bound_to_the_current_verified_image(self):
        target = self.root / 'msa/liquibase/verification.json'
        image_id = 'sha256:' + 'b' * 64
        target.write_text(json.dumps({'passed': True, 'imageId': image_id}))
        with patch.object(verification, 'ROOT', self.root), \
                patch.object(images, 'prepared_image', return_value=image_id), \
                patch.object(images, 'source_commit', return_value=self.deployed), \
                patch.dict(os.environ, BUILD_NUMBER='43'):
            verification.record('database')
            self.assertEqual((self.out / 'verified-database.txt').read_text().strip(), self.deployed + ':43')
            target.write_text(json.dumps({'passed': True, 'imageId': 'sha256:' + 'c' * 64}))
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                verification.record('database')


if __name__ == '__main__':
    unittest.main()
