"""App package/upload tests. Never contact a real server."""
import unittest

import test_deploy


class AppDeploymentTests(unittest.TestCase):
    run_script = test_deploy.DeploymentTests.run_script
    calls = test_deploy.DeploymentTests.calls

    def setUp(self):
        test_deploy.DeploymentTests.setUp(self)

        self.env['RELEASE_NAME'] = test_deploy.RELEASE
        self.env['MSA_INGRESS_HOST'] = 'app.example.test'
        self.env['MSA_CORS_ORIGINS'] = 'https://admin.example.test,https://app.example.test'
        self.service_dir = self.root / 'msa/services/customer'
        self.service_dir.mkdir(parents=True)
        self.manifest = self.service_dir / 'k8s.yaml'
        self.manifest.write_text(
            'image: docker.io/library/dva-customer:RELEASE_TAG\n'
            'host: __MSA_INGRESS_HOST__\n'
            'value: "__MSA_CORS_ORIGINS__"\n'
        )
        self.app_release = (
            self.root / 'msa-release/apps'
            / test_deploy.RELEASE / 'customer'
        )

        ssh = self.bin / 'ssh'
        ssh.write_text(
            test_deploy.FAKE
            + """
if name == 'ssh' and 'bash remote-app.sh' in args[-1]:
    if os.environ.get('FAIL_APP_REMOTE'):
        sys.exit(1)
"""
        )

    def package(self):
        self.run_script('deploy/package-app.sh', 'customer')

    def test_package_contents_and_duplicate_rejected(self):
        self.package()
        expected = (
            'docker.io/library/dva-customer:'
            + test_deploy.RELEASE
        )
        self.assertEqual(
            (self.app_release / 'image-name.txt').read_text().strip(),
            expected,
        )
        self.assertEqual(
            (self.app_release / 'image-id.txt').read_text().strip(),
            test_deploy.IMAGE_ID,
        )
        self.assertIn(
            expected,
            (self.app_release / 'k8s.yaml').read_text(),
        )
        manifest = (self.app_release / 'k8s.yaml').read_text()
        self.assertIn('host: app.example.test', manifest)
        self.assertIn('value: "https://admin.example.test,https://app.example.test"', manifest)
        self.assertTrue(
            (self.app_release / 'remote-app.sh').is_file()
        )
        self.run_script(
            'deploy/package-app.sh', 'customer', ok=False
        )

    def test_invalid_or_missing_addresses_fail_before_packaging(self):
        for variable, value in (
            ('MSA_INGRESS_HOST', ''),
            ('MSA_INGRESS_HOST', 'https://app.example.test/path'),
            ('MSA_CORS_ORIGINS', 'https://app.example.test/path'),
        ):
            with self.subTest(variable=variable, value=value):
                previous = self.env[variable]
                try:
                    self.env[variable] = value
                    result = self.run_script('deploy/package-app.sh', 'customer', ok=False)
                    self.assertIn(variable, result.stderr)
                    self.assertFalse(self.app_release.exists())
                finally:
                    self.env[variable] = previous
        self.assertFalse(any(call[0] == 'docker' for call in self.calls()))

    def test_upload_pins_host_and_invokes_remote(self):
        self.package()
        self.run_script(
            'deploy/upload-app.sh', self.app_release, self.key
        )
        ssh_calls = [c for c in self.calls() if c[0] == 'ssh']
        self.assertEqual(len(ssh_calls), 2)
        self.assertTrue(all(
            'StrictHostKeyChecking=yes' in c
            and 'HostKeyAlias=dva-msa-deploy' in c
            and 'ubuntu@ssh.example.test' in c
            for c in ssh_calls
        ))
        self.assertIn(
            "bash remote-app.sh 'customer'",
            ssh_calls[-1][-1],
        )
        scp = next(c for c in self.calls() if c[0] == 'scp')
        self.assertNotIn(
            str(self.key), scp[scp.index('image.tar'):]
        )

    def test_stage_uploads_once_and_apply_does_not_retransfer(self):
        self.package()
        self.run_script('deploy/upload-app.sh', self.app_release, self.key, 'prepare')
        staged_calls = self.calls()
        self.assertIn("'prepare'", [c for c in staged_calls if c[0] == 'ssh'][-1][-1])
        transfers = len([c for c in staged_calls if c[0] == 'scp'])
        self.run_script('deploy/upload-app.sh', self.app_release, self.key, 'apply')
        self.assertEqual(len([c for c in self.calls() if c[0] == 'scp']), transfers)
        self.assertIn("'apply'", [c for c in self.calls() if c[0] == 'ssh'][-1][-1])

    def test_corruption_blocks_network(self):
        self.package()
        (self.app_release / 'image.tar').write_text('corrupted')
        self.run_script(
            'deploy/upload-app.sh',
            self.app_release,
            self.key,
            ok=False,
        )
        self.assertFalse(any(
            c[0] in ('ssh', 'scp') for c in self.calls()
        ))

    def test_existing_remote_directory_blocks_copy(self):
        self.package()
        self.env['FAIL_MKDIR'] = '1'
        self.run_script(
            'deploy/upload-app.sh',
            self.app_release,
            self.key,
            ok=False,
        )
        self.assertFalse(any(c[0] == 'scp' for c in self.calls()))

    def test_remote_failure_is_not_success(self):
        self.package()
        self.env['FAIL_APP_REMOTE'] = '1'
        self.run_script(
            'deploy/upload-app.sh',
            self.app_release,
            self.key,
            ok=False,
        )
        self.assertTrue(any(
            c[0] == 'ssh' and 'bash remote-app.sh' in c[-1]
            for c in self.calls()
        ))

    def test_wrong_manifest_image_rejected(self):
        self.manifest.write_text(
            'image: docker.io/library/wrong:RELEASE_TAG\n'
        )
        self.run_script(
            'deploy/package-app.sh', 'customer', ok=False
        )


if __name__ == '__main__':
    unittest.main()
