import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_builder', Path(__file__).with_name('build_release.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ReleaseBoundaryTests(unittest.TestCase):
    def test_existing_and_symlink_outputs_are_never_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output, archive = root / 'release', root / 'release.tar.gz'
            output.mkdir()
            marker = output / 'preserved.txt'
            marker.write_text('existing operator work')
            with self.assertRaises(builder.ReleaseError):
                builder.assert_new_outputs(output, archive)
            self.assertEqual(marker.read_text(), 'existing operator work')
            link = root / 'linked-output'
            link.symlink_to(root / 'missing')
            with self.assertRaises(builder.ReleaseError):
                builder.assert_new_outputs(link, archive)

    def test_private_hash_and_key_inputs_are_rejected(self):
        phc = ('$argon2id$v=19$m=19456,t=2,p=1$' +
               base64.b64encode(bytes(16)).decode().rstrip('=') + '$' +
               base64.b64encode(bytes(32)).decode().rstrip('='))
        with self.assertRaises(builder.ReleaseError):
            builder.secret_guard(phc.encode(), '.env.example')
        with self.assertRaises(builder.ReleaseError):
            builder.secret_guard(b'PORTRAIT_STUDIO_ADMIN_PASSWORD=fixture', '.env.example')
        builder.secret_guard(b'# PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH=<private PHC>\nPORTRAIT_STUDIO_ADMIN_USERNAME=admin\n', '.env.example')

    def test_inputs_reject_symlinks_hardlinks_and_excess_size(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.write_bytes(b'safe source')
            linked = root / 'linked'
            linked.symlink_to(source)
            with self.assertRaises(builder.ReleaseError):
                builder.fingerprint(linked)
            with self.assertRaises(builder.ReleaseError):
                builder.fingerprint(source, 2)
            hard = root / 'hard'
            import os
            os.link(source, hard)
            with self.assertRaises(builder.ReleaseError):
                builder.fingerprint(source)

    def test_versions_are_bounded_names_and_deterministic_archive_ignores_host_times(self):
        for invalid in ('../release', 'platform-auth-20261301-r1', 'platform-auth-20261004-r0'):
            with self.assertRaises(builder.ReleaseError):
                builder.check_version(invalid)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'component'
            source.mkdir()
            file = source / 'guide.txt'
            file.write_bytes(b'unchanged component')
            file.chmod(0o644)
            one, two = root / 'one.tar.gz', root / 'two.tar.gz'
            builder.deterministic_archive(source, one)
            import os
            os.utime(file, (987654321, 987654321))
            builder.deterministic_archive(source, two)
            self.assertEqual(one.read_bytes(), two.read_bytes())


if __name__ == '__main__':
    unittest.main()
