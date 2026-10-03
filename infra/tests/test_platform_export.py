"""Only authenticated ciphertext and a fixed, managed tunnel query leave the runner."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import platform_export


@unittest.skipUnless(shutil.which('openssl'), 'OpenSSL is required for the bootstrap envelope')
class EncryptedBootstrap(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.key, self.cert = self.root / 'owner.key', self.root / 'owner.crt'
        result = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                                 '-keyout', str(self.key), '-out', str(self.cert), '-days', '1',
                                 '-subj', '/CN=synthetic-bootstrap'], capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.key.chmod(0o600)
        self.value = {'client_id': 'synthetic-id-' + 'a' * 32,
                      'client_secret': 'synthetic-secret-' + 'b' * 32,
                      'tunnel_id': '00000000-0000-4000-8000-000000000000'}
        self.connector = 'syntheticconnector' + 'c' * 64
        self.session = SimpleNamespace(work=self.root, values={'account_id': 'account'},
                                       tofu=SimpleNamespace(binary='tofu', env={}))
        self.env = {'VPS_BOOTSTRAP_CERT': self.cert.read_text(), 'RUNNER_TEMP': str(self.root)}

    def export(self):
        run = platform_export.subprocess.run
        def execute(args, **kwargs):
            if args[0] == 'tofu':
                return subprocess.CompletedProcess(args, 0, json.dumps(self.value).encode(), b'')
            return run(args, **kwargs)
        self.paths = []
        def fetch(path):
            self.paths.append(path)
            return self.connector
        with patch.object(platform_export.subprocess, 'run', execute):
            platform_export.encrypted_export(self.session, self.env, fetch, self.root)

    def test_real_envelope_decrypts_only_with_the_owner_key(self):
        self.export()
        target = self.root / 'platform-bootstrap.cms'
        ciphertext = target.read_bytes()
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(self.value['client_secret'].encode(), ciphertext)
        self.assertNotIn(self.connector.encode(), ciphertext)
        self.assertEqual(self.paths, ['/accounts/account/cfd_tunnel/' + self.value['tunnel_id'] + '/token'])
        decrypted = subprocess.run(['openssl', 'cms', '-decrypt', '-binary', '-inform', 'DER',
                                    '-in', str(target), '-recip', str(self.cert), '-inkey', str(self.key)],
                                   capture_output=True)
        self.assertEqual(decrypted.returncode, 0)
        self.assertEqual(json.loads(decrypted.stdout), {**self.value, 'connector_token': self.connector, 'version': 1})

    def test_disabled_export_performs_no_credential_query(self):
        with patch.object(platform_export.subprocess, 'run') as run:
            platform_export.encrypted_export(self.session, {}, lambda _: self.fail('unexpected request'), self.root)
        run.assert_not_called()

    def test_invalid_provider_credentials_never_create_an_artifact(self):
        self.value['client_secret'] = 'invalid\nsecret'
        with self.assertRaisesRegex(platform_export.ExportFailed, '^Invalid bootstrap output$'):
            self.export()
        self.assertFalse((self.root / 'platform-bootstrap.cms').exists())
        self.assertEqual(self.paths, [])

    def test_export_does_not_overwrite_an_existing_handoff(self):
        self.export()
        first = (self.root / 'platform-bootstrap.cms').read_bytes()
        with self.assertRaises(FileExistsError):
            self.export()
        self.assertEqual((self.root / 'platform-bootstrap.cms').read_bytes(), first)
