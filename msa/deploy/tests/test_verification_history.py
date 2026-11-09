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
        self.history(self.deployed)
        for filename in ('msa/liquibase/changelog/order/005.sql', 'msa/liquibase/Dockerfile',
                         'msa/liquibase/verify.py', 'msa/liquibase/ci-command.sh'):
            with self.subTest(filename=filename):
                self.commit(filename, 'changed execution input')
                self.assertTrue(self.selection()['database'])

    def test_database_documentation_does_not_repeat_integration(self):
        self.history(self.deployed)
        self.commit('msa/liquibase/README.md', 'documentation only')
        self.assertFalse(self.selection()['database'])

    def test_event_test_change_selects_event_checks_without_business_matrix(self):
        self.history(self.deployed)
        self.commit('msa/shared/events/test/unit.test.cjs', 'new event assertion')
        result = self.selection()
        self.assertTrue(result['events'])
        self.assertFalse(result['database'])
        self.assertEqual(result['paritySuites'], [])

    def test_invalid_or_missing_history_never_skips_changed_inputs(self):
        self.commit('msa/liquibase/verify.py', 'changed verifier')
        for value in ({}, {'database': '0' * 40 + ':42'}, {'database': '--invalid'},
                      {'database': None}, ['invalid'], 'invalid JSON'):
            with self.subTest(value=value):
                (self.out / 'verification-history.json').write_text(value if isinstance(value, str) else json.dumps(value))
                self.assertTrue(self.selection()['database'])

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
