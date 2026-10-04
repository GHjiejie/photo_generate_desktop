"""Offline fake-root transactions. No SSH, service, socket or real config access."""
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch

import archive_validation as archive
import deploy_server as deploy
from test_caddy_review import ORIGINAL, configs


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def elf_fixture():
    raw = bytearray(120)
    raw[:8] = b'\x7fELF\x02\x01\x01\0'
    struct.pack_into('<HH', raw, 16, 2, 62)
    struct.pack_into('<Q', raw, 32, 64)
    struct.pack_into('<HH', raw, 54, 56, 1)
    struct.pack_into('<I', raw, 64, 1)
    return bytes(raw)


def library_fixture(stage):
    """Small synthetic bytes: real bounded tar/index/hash verification, no rasters."""
    files, items = {}, []
    for number in range(1, 101):
        relative = 'assets/images/' + str(number) + '.png'
        raw = b'fixture-only-image-bytes-' + str(number).encode()
        files['photo_repo/' + relative] = raw
        items.append({'id': number, 'label': 'Fixture ' + str(number), 'type': 'photo',
            'prompts': {'en': 'Complete English fixture prompt ' + str(number), 'zh': '完整中文夹具提示词 ' + str(number)},
            'revision': 1, 'mime': 'image/png', 'imageRel': relative, 'image': str(number) + '.png',
            'size': len(raw), 'sha256': digest(raw), 'sourceMetadata': {'fixtureOnly': True}})
    files['photo_repo/.portrait-studio/library.json'] = json.dumps({'schemaVersion': 1, 'revision': 3, 'items': items}, ensure_ascii=False).encode()
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0) as zipped:
        import tarfile
        with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as container:
            for name, raw in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                member.mode = 0o600
                container.addfile(member, io.BytesIO(raw))
    raw = stream.getvalue()
    (stage / 'library.tar.gz').write_bytes(raw)
    manifest = {'schemaVersion': 1, 'root': 'photo_repo', 'count': 100, 'revision': 3,
        'archiveFormat': 'tar.gz', 'archiveSha256': digest(raw), 'archiveSize': len(raw),
        'totalSize': sum(map(len, files.values())), 'files': [{'path': name, 'size': len(value), 'sha256': digest(value)} for name, value in sorted(files.items())]}
    (stage / 'library.manifest.json').write_bytes(json.dumps(manifest).encode())
    return files, manifest


class FakeCommands:
    def __init__(self, paths):
        self.paths, self.calls = paths, []
        self.bad_exec = None
        self.extra_environment = False
        self.runtime_lock_mode = 0o600
        self.runtime_lock_content = b''
        self.port_busy = False

    def effective(self):
        binary = str(self.paths.app / 'bin/portrait-server')
        argv = binary + ' -listen 127.0.0.1:4137 -data ' + str(self.paths.app / 'data/photo_repo') + ' -version ' + deploy.RELEASE_VERSION
        if self.bad_exec is not None:
            binary, argv = self.bad_exec(binary, argv)
        environment = 'PORTRAIT_STUDIO_ADMIN_USERNAME=admin PORTRAIT_STUDIO_AUTH_FILE=/home/ubuntu/portrait-studio/config/admin-auth.json'
        if self.extra_environment:
            environment += ' UNKNOWN_FIXTURE_ENV=1'
        return ('FragmentPath=' + str(self.paths.unit) + '\nUser=ubuntu\nGroup=ubuntu\nDropInPaths=\nExecStart={ path=' + binary +
            ' ; argv[]=' + argv + ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\nEnvironment=' + environment + '\n').encode()

    def run(self, argv, label):
        self.calls.append((list(argv), label))
        if argv[0] == '/usr/bin/caddy':
            if argv[1] == 'adapt':
                path = Path(argv[argv.index('--config') + 1])
                before, after = configs()
                value = after if deploy.HOST.encode() in path.read_bytes() else before
                return json.dumps(value).encode()
            return b''
        if argv[0] == '/usr/bin/ss':
            return b'occupied fixture' if self.port_busy else b''
        if '--property=LoadState' in argv:
            return b'not-found\n' if not self.paths.unit.exists() else b'loaded\n'
        if '--property=FragmentPath' in argv:
            return self.effective()
        if argv[1] == 'enable':
            self.paths.enabled.symlink_to(self.paths.unit)
        if argv[1] == 'disable' and self.paths.enabled.is_symlink():
            self.paths.enabled.unlink()
        if argv[1] == 'start':
            meta = self.paths.app / 'data/photo_repo/.portrait-studio'
            for directory in ('go-transactions', 'recovery', 'go-staging'):
                (meta / directory).mkdir(mode=0o700)
            lock = meta / 'go-store.lock'
            lock.write_bytes(self.runtime_lock_content)
            lock.chmod(self.runtime_lock_mode)
        return b''


class TransactionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='portrait-platform-fixture-', dir='/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / '.portrait-platform-test-only').write_bytes(b'no-network\n')
        app = self.root / 'home/ubuntu/portrait-studio'
        caddy = self.root / 'etc/caddy/Caddyfile'
        unit = self.root / 'etc/systemd/system/portrait-studio.service'
        enabled = self.root / 'etc/systemd/system/multi-user.target.wants/portrait-studio.service'
        for path in (app.parent, caddy.parent, unit.parent, enabled.parent, self.root / 'run/systemd/system', self.root / 'usr/lib/systemd/system'):
            path.mkdir(parents=True, exist_ok=True)
        self.paths = deploy.Paths(app, caddy, unit, enabled, (unit.parent, self.root / 'run/systemd/system', self.root / 'usr/lib/systemd/system'))
        caddy.write_bytes(ORIGINAL)
        caddy.chmod(0o644)
        self.commands = FakeCommands(self.paths)
        self.runtime = deploy.Runtime(self.paths, self.commands, test_mode=True, test_root=self.root)
        self.stage = self.root / 'stage'
        self.stage.mkdir(mode=0o700)
        (self.stage / 'portrait-server').write_bytes(elf_fixture())
        (self.stage / 'portrait-studio.service').write_bytes(deploy.EXPECTED_UNIT)
        self.seed, self.manifest = library_fixture(self.stage)
        self.pins = {'binarySha256': digest((self.stage / 'portrait-server').read_bytes()),
            'unitSha256': digest(deploy.EXPECTED_UNIT), 'manifestSha256': digest((self.stage / 'library.manifest.json').read_bytes()),
            'archiveSha256': self.manifest['archiveSha256']}
        self.plan_dir = self.root / 'private-plan'
        self.deployment_id = 'e' * 32
        self.http_calls = []
        self.addCleanup(patch.stopall)
        patch.object(deploy.subprocess, 'run', side_effect=AssertionError('Real subprocess forbidden')).start()
        patch.object(deploy.urllib.request, 'build_opener', side_effect=AssertionError('Real network forbidden')).start()

    def plan(self):
        return self.runtime.plan(self.stage, self.plan_dir, self.deployment_id, self.pins)

    def prepare(self):
        self.review = self.plan()
        return self.runtime.prepare(self.plan_dir, self.deployment_id, self.review['candidateSha256'])

    def initialized(self):
        self.prepare()
        credential = self.paths.app / 'config/admin-auth.json'
        credential.write_bytes(b'not-a-real-hash-fixture-stat-only')
        credential.chmod(0o600)
        return credential

    def fake_http(self, base, healthy_wait=False):
        self.http_calls.append((base, healthy_wait))

    def activate(self):
        return self.runtime.activate(self.deployment_id, self.review['candidateSha256'], self.fake_http)

    def material(self):
        data = self.paths.app / 'data/photo_repo'
        return {path.relative_to(data).as_posix(): path.read_bytes() for path in data.rglob('*') if path.is_file()}

    def test_full_fresh_transaction_runtime_lock_and_guarded_rollback_retain_every_seed_and_admin_byte(self):
        credential = self.initialized()
        before = self.material()
        secret = credential.read_bytes()
        actual_read = deploy.read_file
        def no_credential_reads(path, *args, **kwargs):
            self.assertNotEqual(Path(path), credential, 'Deployment code must never read the private admin hash')
            return actual_read(path, *args, **kwargs)
        with patch.object(deploy, 'read_file', side_effect=no_credential_reads):
            result = self.activate()
            self.assertEqual(result['status'], 'active')
            self.assertEqual(self.http_calls, [(deploy.LOOPBACK, True), (deploy.PUBLIC, False)])
            self.assertTrue(self.paths.caddy.read_bytes().startswith(ORIGINAL))
            self.assertEqual(stat.S_IMODE(self.paths.unit.stat().st_mode), 0o644)
            self.assertEqual(self.material(), {**before, '.portrait-studio/go-store.lock': b''})
            review = self.runtime.rollback_plan(self.deployment_id)
            rolled = self.runtime.rollback(self.deployment_id, review['rollbackApprovalSha256'])
        self.assertEqual(rolled['status'], 'rolled-back')
        self.assertEqual(self.paths.caddy.read_bytes(), ORIGINAL)
        self.assertFalse(self.paths.unit.exists())
        self.assertFalse(self.paths.enabled.is_symlink())
        self.assertEqual(credential.read_bytes(), secret)
        self.assertEqual(self.material(), {**before, '.portrait-studio/go-store.lock': b''})
        state = self.runtime.read_state(self.deployment_id)
        self.assertEqual(state['status'], 'rolled-back')

    def test_existing_application_unit_dropin_or_busy_port_is_never_overwritten(self):
        for obstruction in ('app', 'unit', 'dropin', 'port'):
            with self.subTest(obstruction=obstruction):
                if obstruction == 'app':
                    self.paths.app.mkdir()
                elif obstruction == 'unit':
                    self.paths.unit.write_bytes(b'existing unit')
                elif obstruction == 'dropin':
                    (self.paths.unit.parent / (deploy.SERVICE + '.d')).mkdir()
                else:
                    self.commands.port_busy = True
                with self.assertRaises(deploy.DeploymentError):
                    self.plan()
                self.assertFalse(self.plan_dir.exists())
                if obstruction == 'app':
                    self.paths.app.rmdir()
                elif obstruction == 'unit':
                    self.paths.unit.unlink()
                elif obstruction == 'dropin':
                    (self.paths.unit.parent / (deploy.SERVICE + '.d')).rmdir()
                self.commands.port_busy = False
        self.assertEqual(self.paths.caddy.read_bytes(), ORIGINAL)

    def test_corrupted_staged_archive_or_sidecar_fails_before_app_creation(self):
        raw = (self.stage / 'library.tar.gz').read_bytes()
        (self.stage / 'library.tar.gz').write_bytes(raw + b'changed')
        with self.assertRaises(deploy.DeploymentError):
            self.plan()
        self.assertFalse(self.paths.app.exists())
        self.assertFalse(self.plan_dir.exists())

    def test_personal_approval_and_late_caddy_bytes_are_checked_before_preparation(self):
        review = self.plan()
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.prepare(self.plan_dir, self.deployment_id, '0' * 64)
        self.paths.caddy.write_bytes(ORIGINAL + b'# operator change\n')
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.prepare(self.plan_dir, self.deployment_id, review['candidateSha256'])
        self.assertFalse(self.paths.app.exists())

    def test_uninitialized_or_insecure_admin_config_never_installs_unit_or_caddy(self):
        self.prepare()
        with self.assertRaises((deploy.DeploymentError, FileNotFoundError)):
            self.activate()
        credential = self.paths.app / 'config/admin-auth.json'
        credential.write_bytes(b'fixture')
        credential.chmod(0o644)
        with self.assertRaises(deploy.DeploymentError):
            self.activate()
        self.assertFalse(self.paths.unit.exists())
        self.assertEqual(self.paths.caddy.read_bytes(), ORIGINAL)

    def test_changed_seed_is_detected_before_service_activation(self):
        self.initialized()
        (self.paths.app / 'data/photo_repo/assets/images/1.png').write_bytes(b'changed fixture')
        with self.assertRaises(deploy.DeploymentError):
            self.activate()
        self.assertFalse(self.paths.unit.exists())
        self.assertFalse(self.http_calls)

    def test_unsafe_runtime_lock_causes_compensating_rollback_without_seed_loss(self):
        self.initialized()
        before = self.material()
        self.commands.runtime_lock_content = b'unexpected'
        with self.assertRaises(deploy.DeploymentError):
            self.activate()
        self.assertEqual(self.paths.caddy.read_bytes(), ORIGINAL)
        self.assertFalse(self.paths.unit.exists())
        self.assertEqual({k: v for k, v in self.material().items() if k != '.portrait-studio/go-store.lock'}, before)
        self.assertEqual(self.runtime.read_state(self.deployment_id)['status'], 'rolled-back')

    def test_effective_command_must_have_exact_executable_arguments_and_version(self):
        self.prepare()
        self.runtime.effective_unit()
        mutations = [lambda binary, argv: ('/different/' + binary, argv),
            lambda binary, argv: (binary, argv + ' -listen 0.0.0.0:4137'),
            lambda binary, argv: (binary, argv.replace(deploy.RELEASE_VERSION, 'older-version')),
            lambda binary, argv: (binary, argv.replace('127.0.0.1:4137', '0.0.0.0:4137'))]
        for mutation in mutations:
            self.commands.bad_exec = mutation
            with self.assertRaises(deploy.DeploymentError):
                self.runtime.effective_unit()
        self.commands.bad_exec = None
        self.commands.extra_environment = True
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.effective_unit()

    def test_operator_caddy_or_unit_changes_block_rollback_before_stop_or_restore(self):
        self.initialized()
        self.activate()
        state = self.runtime.read_state(self.deployment_id)
        candidate = self.paths.caddy.read_bytes()
        self.paths.caddy.write_bytes(candidate + b'# user change\n')
        before_calls = len(self.commands.calls)
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.rollback(self.deployment_id, digest(deploy.encoded(state)))
        self.assertEqual(len(self.commands.calls), before_calls)
        self.paths.caddy.write_bytes(candidate)
        self.paths.unit.write_bytes(deploy.EXPECTED_UNIT + b'# operator change\n')
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.rollback(self.deployment_id, digest(deploy.encoded(state)))
        self.assertEqual(self.paths.caddy.read_bytes(), candidate)

    def test_rollback_stale_state_approval_and_enablement_alias_fail_closed(self):
        self.initialized()
        self.activate()
        review = self.runtime.rollback_plan(self.deployment_id)
        state = self.runtime.read_state(self.deployment_id)
        state['status'] = 'operator-reviewed-change'
        self.runtime.save_state(state)
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.rollback(self.deployment_id, review['rollbackApprovalSha256'])
        self.paths.enabled.unlink()
        self.paths.enabled.symlink_to(self.root / 'unrelated-service')
        with self.assertRaises(deploy.DeploymentError):
            self.runtime.rollback_plan(self.deployment_id)

    def test_late_mode_change_is_preserved_by_atomic_compare_and_swap(self):
        original_read = deploy.read_file
        count = 0
        def change_mode(path, *args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                self.paths.caddy.chmod(0o640)
            return original_read(path, *args, **kwargs)
        with patch.object(deploy, 'read_file', side_effect=change_mode), self.assertRaises(deploy.DeploymentError):
            deploy.atomic_replace(self.paths.caddy, ORIGINAL + b'# candidate\n', digest(ORIGINAL), 0o644, os.getuid(), self.paths.caddy.stat().st_gid)
        self.assertEqual(self.paths.caddy.read_bytes(), ORIGINAL)
        self.assertEqual(stat.S_IMODE(self.paths.caddy.stat().st_mode), 0o640)

    def test_umask_does_not_make_root_app_inaccessible_or_service_wrong_mode(self):
        previous = os.umask(0o077)
        try:
            self.initialized()
            self.activate()
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE(self.paths.app.stat().st_mode), 0o750)
        self.assertEqual(stat.S_IMODE(self.paths.unit.stat().st_mode), 0o644)

    def test_explicit_test_runtime_cannot_use_real_commands_or_external_paths(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.Runtime(self.paths, deploy.Commands(), test_mode=True, test_root=self.root)
        with self.assertRaises(deploy.DeploymentError):
            deploy.Runtime(deploy.Paths(), self.commands, test_mode=True, test_root=self.root)
        with self.assertRaises(deploy.DeploymentError):
            deploy.Runtime(self.paths, self.commands)


class PublicVerificationTests(unittest.TestCase):
    def fixture_fetch(self, url):
        self.calls.append(url)
        if url.endswith('healthz'):
            return 200, {}, {'ok': True, 'data': {'status': 'ok', 'version': self.version}}
        if url.endswith('auth/status'):
            return 200, {}, {'ok': True, 'data': {'initialized': self.initialized, 'authenticated': False}}
        return self.business_status, {'WWW-Authenticate': self.challenge}, {'ok': False, 'error': {'code': 'AUTH_REQUIRED'}}

    def setUp(self):
        self.calls, self.version, self.initialized = [], deploy.RELEASE_VERSION, True
        self.business_status, self.challenge = 401, 'Bearer realm="Portrait Studio"'

    def test_exact_release_initialized_admin_and_unsigned_bearer_business_proof(self):
        with patch.object(deploy, 'fetch', self.fixture_fetch):
            deploy.verify_http(deploy.PUBLIC)
        self.assertEqual(len(self.calls), 5)
        self.assertTrue(all(url.startswith(deploy.PUBLIC) for url in self.calls))
        self.assertFalse(any('login' in url or 'session' in url for url in self.calls))

    def test_wrong_release_uninitialized_basic_or_public_success_are_rejected(self):
        for name, bad, good in [('version', 'old-release', deploy.RELEASE_VERSION),
            ('initialized', False, True), ('challenge', 'Basic realm="old-gateway"', 'Bearer realm="Portrait Studio"'),
            ('business_status', 200, 401)]:
            setattr(self, name, bad)
            with patch.object(deploy, 'fetch', self.fixture_fetch), self.assertRaises(deploy.DeploymentError):
                deploy.verify_http(deploy.PUBLIC)
            setattr(self, name, good)


if __name__ == '__main__':
    unittest.main()
