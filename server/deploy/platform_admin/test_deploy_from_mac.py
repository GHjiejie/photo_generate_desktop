"""Offline platform-wrapper contracts; no SSH, SCP, real library or credentials.

All payloads and receipts use a canonical /tmp fixture with an explicit
no-network sentinel. The production verifier reads small pinned fixture bytes;
only archive parsing and the public Caddy block are substituted selectively.
Every subprocess boundary is forbidden unless an explicit fake runner owns it.
"""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    'platform_deploy_from_mac_under_test', Path(__file__).with_name('deploy_from_mac.py'))
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)

BEFORE_SHA = 'a' * 64
CANDIDATE_SHA = 'b' * 64
STATE_SHA = 'c' * 64
ROLLBACK_SHA = 'd' * 64
DEPLOYMENT_ID = 'e' * 32
PUBLIC_BLOCK = 'portrait-18-180-65-241.sslip.io {\n # public block fixture\n}\n'


class FixtureArchiveError(Exception):
    pass


class NoNetworkRunner:
    """Records argument vectors and returns synthetic phase receipts only."""
    no_network = True

    def __init__(self, testcase, *, require_early_receipt=False, fail_phase=None):
        self.testcase = testcase
        self.require_early_receipt = require_early_receipt
        self.fail_phase = fail_phase
        self.calls = []
        self.overrides = {}

    def __call__(self, argv, **kwargs):
        case = self.testcase
        case.assertIn(argv[0], ('/usr/bin/ssh', '/usr/bin/scp'))
        if not self.calls and self.require_early_receipt:
            receipt = deploy.read_receipt()
            case.assertEqual(receipt['status'], 'staging-requested')
            case.assertEqual(receipt['deploymentId'], DEPLOYMENT_ID)
            case.assertIsNone(receipt['candidateSha256'])
            case.assertEqual(receipt['staging'], '/tmp/portrait-platform-stage-' + DEPLOYMENT_ID)
            case.assertEqual(receipt['privatePlan'], '/tmp/portrait-platform-plan-' + DEPLOYMENT_ID)
            case.assertEqual(stat.S_IMODE(case.receipt.stat().st_mode), 0o600)
        call = {'argv': list(argv), 'kwargs': dict(kwargs)}
        self.calls.append(call)
        words = shlex.split(argv[-1]) if argv[0] == '/usr/bin/ssh' else []
        operation = (words[words.index('--phase') + 1] if '--phase' in words else
                     'upload' if argv[0] == '/usr/bin/scp' else
                     'init-admin' if '-tt' in argv else 'staging')
        if operation == self.fail_phase:
            if '--phase' in words:
                call['phase'] = operation
            return subprocess.CompletedProcess(argv, 1, stdout=b'PRIVATE_SYNTHETIC_OUTPUT', stderr=b'PRIVATE_SYNTHETIC_ERROR')
        if '--phase' not in words:
            return subprocess.CompletedProcess(argv, 0, stdout=None)
        phase = words[words.index('--phase') + 1]
        call['phase'] = phase
        deployment_id = words[words.index('--deployment-id') + 1]
        results = {
            'plan': {'status': 'review-required', 'deploymentId': deployment_id,
                     'endpoint': deploy.PUBLIC_URL,
                     'candidatePath': '/tmp/portrait-platform-plan-' + deployment_id + '/Caddyfile.candidate',
                     'existingRoutesUnchanged': True, 'beforeSha256': BEFORE_SHA,
                     'candidateSha256': CANDIDATE_SHA, 'publicBlock': PUBLIC_BLOCK},
            'prepare': {'status': 'awaiting-admin-initialization', 'deploymentId': deployment_id,
                        'state': deploy.STATE, 'count': 100, 'revision': 3},
            'activate': {'status': 'active', 'deploymentId': deployment_id, 'state': deploy.STATE,
                         'count': 100, 'revision': 3, 'initialized': True,
                         'unsignedBusinessStatus': 401, 'existingCaddyAuthenticationUnchanged': True,
                         'stateSha256': STATE_SHA},
            'rollback-plan': {'status': 'rollback-review-required', 'deploymentId': deployment_id,
                              'state': deploy.STATE, 'dataRetained': True,
                              'privateAdminConfigurationRetained': True, 'rollbackApprovalSha256': ROLLBACK_SHA},
            'rollback': {'status': 'rolled-back', 'deploymentId': deployment_id,
                         'dataRetained': True, 'privateAdminConfigurationRetained': True},
        }
        case.assertIn(phase, results)
        result = {**results[phase], **self.overrides.get(phase, {})}
        return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(result).encode())

    @property
    def phases(self):
        return [call['phase'] for call in self.calls if 'phase' in call]


class PlatformDeployFromMacTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='portrait-platform-wrapper-test-', dir='/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / '.portrait-platform-test-only').write_bytes(b'no-network\n')
        self.tool_dir = self.root / deploy.DIRECTORY
        self.tool_dir.mkdir(parents=True)
        self.release = self.root / 'server/dist' / deploy.RELEASE
        (self.release / 'bin').mkdir(parents=True)
        self.receipt = self.root / 'server/dist/portrait-studio-platform-admin-receipt.json'
        self.binary = b'SYNTHETIC_STATIC_ELF_NEVER_EXECUTED\n'
        self.files = {deploy.DIRECTORY + name: ('# fixture ' + name + ', never executed\n').encode()
                      for name in deploy.RUNTIME_FILES}
        self.files[deploy.DIRECTORY + 'portrait-studio.service'] = b'[Service]\nExecStart=/fixture/portrait-server\n'
        self.files['server/dist/' + deploy.RELEASE + '/bin/portrait-server'] = self.binary
        for relative, raw in self.files.items():
            (self.root / relative).write_bytes(raw)
        self.archive = self.root / 'server/dist/library fixture $(never-executed).tar.gz'
        self.archive.write_bytes(b'SYNTHETIC_PINNED_ARCHIVE_NEVER_IMPORTED\n')
        self.sidecar = Path(str(self.archive) + '.manifest.json')
        self.sidecar_document = {'schemaVersion': 1, 'count': 100, 'revision': 3,
                                 'archiveSha256': self.digest(self.archive)}
        self.write_json(self.sidecar, self.sidecar_document)
        self.release_manifest = {
            'schemaVersion': 1, 'releaseVersion': deploy.RELEASE_VERSION,
            'binary': {'path': 'bin/portrait-server', 'os': 'linux', 'arch': 'amd64',
                       'static': True, 'size': len(self.binary), 'sha256': self.digest_bytes(self.binary)},
            'files': {'bin/portrait-server': {'size': len(self.binary), 'sha256': self.digest_bytes(self.binary)}},
            'library': {'archiveSha256': self.digest(self.archive), 'manifestSha256': self.digest(self.sidecar),
                        'count': 100, 'revision': 3, 'external': True},
        }
        self.release_manifest_path = self.release / 'release-manifest.json'
        self.write_json(self.release_manifest_path, self.release_manifest)
        self.files['server/dist/' + deploy.RELEASE + '/release-manifest.json'] = self.release_manifest_path.read_bytes()
        self.manifest_path = self.tool_dir / 'manifest.json'
        self.manifest = {
            'schemaVersion': 2, 'target': deploy.TARGET, 'endpoint': deploy.PUBLIC_URL,
            'releaseVersion': deploy.RELEASE_VERSION,
            'files': {name: {'size': len(raw), 'sha256': self.digest_bytes(raw)} for name, raw in self.files.items()},
            'library': {'archiveSha256': self.digest(self.archive), 'archiveSize': self.archive.stat().st_size,
                        'manifestSha256': self.digest(self.sidecar), 'count': 100, 'revision': 3,
                        'root': 'photo_repo', 'external': True},
        }
        self.write_json(self.manifest_path, self.manifest)
        for name, value in {
            'ROOT': self.root, 'MANIFEST': self.manifest_path, 'DEFAULT_ARCHIVE': self.archive,
            'DEFAULT_RELEASE': self.release, 'RECEIPT': self.receipt,
            'BINARY_SHA': self.digest_bytes(self.binary),
            'RELEASE_MANIFEST_SHA': self.digest(self.release_manifest_path),
            'ARCHIVE_SHA': self.digest(self.archive), 'SIDECAR_SHA': self.digest(self.sidecar),
        }.items():
            self.patch(deploy, name, value)
        self.validator = types.SimpleNamespace(
            check_static_elf=Mock(), inspect_archive=Mock(), DeploymentError=FixtureArchiveError)
        self.pure_module = self.patch(deploy, 'pure_module', side_effect=self.fixture_module)
        self.real_subprocess = self.patch(deploy.subprocess, 'run', side_effect=AssertionError('Real subprocess forbidden by offline fixtures'))
        self.patch(deploy.subprocess, 'Popen', side_effect=AssertionError('Real process forbidden by offline fixtures'))
        self.patch(deploy.uuid, 'uuid4', return_value=types.SimpleNamespace(hex=DEPLOYMENT_ID))

    def patch(self, owner, name, *args, **kwargs):
        patcher = patch.object(owner, name, *args, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def fixture_module(self, name, raw):
        if name == 'portrait_archive_verify':
            self.assertEqual(raw, self.files[deploy.DIRECTORY + 'archive_validation.py'])
            return self.validator
        if name == 'portrait_caddy_public':
            self.assertEqual(raw, self.files[deploy.DIRECTORY + 'caddy_review.py'])
            return types.SimpleNamespace(PUBLIC_BLOCK=PUBLIC_BLOCK)
        self.fail('Unreviewed fixture module requested: ' + name)

    @staticmethod
    def digest_bytes(raw):
        return hashlib.sha256(raw).hexdigest()

    def digest(self, filename):
        return self.digest_bytes(Path(filename).read_bytes())

    @staticmethod
    def write_json(filename, value):
        Path(filename).write_text(json.dumps(value, sort_keys=True) + '\n', encoding='utf-8')

    def tree_bytes(self):
        return {str(file.relative_to(self.root)): file.read_bytes()
                for file in self.root.rglob('*') if file.is_file() and not file.is_symlink()}

    def cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = deploy.main(list(args))
        return code, stdout.getvalue(), stderr.getvalue()

    def transport(self, **kwargs):
        runner = NoNetworkRunner(self, **kwargs)
        return deploy.Transport(test_mode=True, test_root=self.root, runner=runner), runner

    def stopped_before_remote(self):
        before = self.tree_bytes()
        with patch.object(sys.stdin, 'isatty', return_value=True), patch.object(sys.stdout, 'isatty', return_value=True):
            code, _, stderr = self.cli('--apply')
        self.assertEqual(code, 1)
        self.assertIn('Deployment stopped:', stderr)
        self.real_subprocess.assert_not_called()
        self.assertEqual(self.tree_bytes(), before)

    def run_apply(self, transport, approval=CANDIDATE_SHA):
        with patch.object(deploy, 'user_tty'), patch('builtins.input', return_value=approval), \
                contextlib.redirect_stdout(io.StringIO()):
            return deploy.apply(self.archive, transport=transport)

    def write_active_receipt(self, **updates):
        receipt = {'schemaVersion': 2, 'target': deploy.TARGET, 'endpoint': deploy.PUBLIC_URL,
                   'state': deploy.STATE, 'deploymentId': DEPLOYMENT_ID,
                   'candidateSha256': CANDIDATE_SHA, 'beforeSha256': BEFORE_SHA,
                   'status': 'active', 'credentialsStoredLocally': False, 'dataRetainedOnRollback': True,
                   **updates}
        deploy.write_receipt(receipt)
        return receipt

    def test_default_and_prepare_do_full_offline_preflight_without_writes(self):
        before = self.tree_bytes()
        for args in [(), ('--prepare',), ('--prepare', '--archive', str(self.archive))]:
            with self.subTest(args=args):
                self.validator.check_static_elf.reset_mock()
                self.validator.inspect_archive.reset_mock()
                code, stdout, stderr = self.cli(*args)
                self.assertEqual((code, stderr), (0, ''))
                summary = json.loads(stdout)
                self.assertEqual(summary['status'], 'offline-payload-verified')
                self.assertEqual((summary['remoteActions'], summary['count'], summary['revision']), (0, 100, 3))
                self.assertEqual((summary['target'], summary['endpoint']), (deploy.TARGET, deploy.PUBLIC_URL))
                self.assertEqual(summary['archiveSha256'], self.digest(self.archive))
                self.validator.check_static_elf.assert_called_once_with(self.binary)
                self.validator.inspect_archive.assert_called_once_with(self.archive, self.sidecar_document)
                self.real_subprocess.assert_not_called()
                self.assertEqual(self.tree_bytes(), before)

    def test_archive_preflight_failure_is_an_offline_safe_error(self):
        self.validator.inspect_archive.side_effect = FixtureArchiveError('PRIVATE_FIXTURE_DETAIL')
        code, _, stderr = self.cli('--prepare')
        self.assertEqual(code, 1)
        self.assertIn('Full library archive validation failed.', stderr)
        self.assertNotIn('PRIVATE_FIXTURE_DETAIL', stderr)
        self.real_subprocess.assert_not_called()
        self.assertFalse(self.receipt.exists())

    def test_manifest_identity_and_file_map_changes_stop_before_remote(self):
        original = copy.deepcopy(self.manifest)
        mutations = [('target', 'other@invalid.example'), ('endpoint', 'https://other.invalid/'),
                     ('schemaVersion', 1), ('releaseVersion', 'other-version')]
        for field, value in mutations:
            with self.subTest(field=field):
                self.write_json(self.manifest_path, {**original, field: value})
                self.stopped_before_remote()
        for name in ['../../outside', 'server/deploy/platform_admin/unreviewed.py']:
            with self.subTest(path=name):
                changed = copy.deepcopy(original)
                changed['files'][name] = {'size': 1, 'sha256': 'f' * 64}
                self.write_json(self.manifest_path, changed)
                self.stopped_before_remote()
        changed = copy.deepcopy(original)
        changed['files'].pop(deploy.DIRECTORY + 'deploy_server.py')
        self.write_json(self.manifest_path, changed)
        self.stopped_before_remote()

    def test_runtime_archive_sidecar_and_binary_byte_changes_stop_before_remote(self):
        paths = [self.root / name for name in self.files] + [self.archive, self.sidecar]
        for filename in paths:
            with self.subTest(file=str(filename.relative_to(self.root))):
                original = filename.read_bytes()
                filename.write_bytes(original + b'tamper')
                self.stopped_before_remote()
                filename.write_bytes(original)

    def test_pin_size_and_library_identity_changes_stop_before_remote(self):
        original = copy.deepcopy(self.manifest)
        for field, value in [('sha256', 'f' * 64), ('sha256', 'invalid'), ('size', 0)]:
            with self.subTest(pin=field, value=value):
                changed = copy.deepcopy(original)
                changed['files'][deploy.DIRECTORY + 'deploy_server.py'][field] = value
                self.write_json(self.manifest_path, changed)
                self.stopped_before_remote()
        for field, value in [('count', 99), ('revision', 2), ('root', 'other_repo'),
                             ('archiveSha256', 'f' * 64), ('manifestSha256', 'f' * 64), ('archiveSize', 1)]:
            with self.subTest(library=field):
                changed = copy.deepcopy(original)
                changed['library'][field] = value
                self.write_json(self.manifest_path, changed)
                self.stopped_before_remote()

    def test_duplicate_nonfinite_and_nonobject_manifest_metadata_stop_early(self):
        for raw in [b'{"schemaVersion":2,"schemaVersion":2}', b'{"field":NaN}', b'[]', b'null', b'\xff', b'{bad']:
            with self.subTest(raw=raw):
                self.manifest_path.write_bytes(raw)
                self.stopped_before_remote()

    def test_symlink_ancestor_hardlink_missing_and_empty_files_fail_closed(self):
        filename = self.root / deploy.DIRECTORY / 'deploy_server.py'
        original = filename.read_bytes()
        filename.unlink()
        code, _, _ = self.cli('--apply')
        self.assertEqual(code, 1)
        self.real_subprocess.assert_not_called()
        filename.write_bytes(b'')
        self.stopped_before_remote()
        filename.write_bytes(original)
        alias = self.root / 'same-runtime-bytes'
        os.link(filename, alias)
        self.stopped_before_remote()
        alias.unlink()
        filename.unlink()
        alias.write_bytes(original)
        filename.symlink_to(alias)
        self.stopped_before_remote()
        directory_alias = self.root / 'archive-dir-alias'
        directory_alias.symlink_to(self.archive.parent, target_is_directory=True)
        with self.assertRaises(deploy.DeliveryError):
            deploy.verify_payload(directory_alias / self.archive.name)
        self.real_subprocess.assert_not_called()

    def test_reviewed_release_path_and_static_target_are_required(self):
        with self.assertRaises(deploy.DeliveryError):
            deploy.verify_release(self.root / 'unreviewed-release')
        for field, value in [('os', 'darwin'), ('arch', 'arm64'), ('static', False), ('path', '../portrait-server')]:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.release_manifest)
                changed['binary'][field] = value
                self.write_json(self.release_manifest_path, changed)
                with patch.object(deploy, 'RELEASE_MANIFEST_SHA', self.digest(self.release_manifest_path)), self.assertRaises(deploy.DeliveryError):
                    deploy.verify_release(self.release)
        self.real_subprocess.assert_not_called()

    def test_apply_requires_both_user_tty_streams_before_any_remote_or_receipt(self):
        for stdin_tty, stdout_tty in [(False, False), (False, True), (True, False)]:
            with self.subTest(stdin=stdin_tty, stdout=stdout_tty), \
                    patch.object(sys.stdin, 'isatty', return_value=stdin_tty), \
                    patch.object(sys.stdout, 'isatty', return_value=stdout_tty):
                with self.assertRaisesRegex(deploy.DeliveryError, 'interactive terminal'):
                    deploy.apply(self.archive)
                self.real_subprocess.assert_not_called()
                self.assertFalse(self.receipt.exists())

    def test_approval_requires_complete_exact_sha(self):
        for entered in ['', CANDIDATE_SHA[:12], CANDIDATE_SHA.upper(), BEFORE_SHA]:
            with self.subTest(entered=entered), patch('builtins.input', return_value=entered), self.assertRaises(deploy.DeliveryError):
                deploy.confirm_sha('fixture public SHA', CANDIDATE_SHA)
        with patch('builtins.input', return_value=CANDIDATE_SHA):
            deploy.confirm_sha('fixture public SHA', CANDIDATE_SHA)
        with patch('builtins.input') as prompt, self.assertRaises(deploy.DeliveryError):
            deploy.confirm_sha('fixture', 'not-a-digest')
        prompt.assert_not_called()

    def test_apply_records_receipt_before_first_remote_and_retains_on_sha_cancel(self):
        transport, runner = self.transport(require_early_receipt=True)
        with self.assertRaisesRegex(deploy.DeliveryError, 'Exact SHA approval'):
            self.run_apply(transport, approval='no')
        self.assertEqual(runner.phases, ['plan'])
        receipt = deploy.read_receipt()
        self.assertEqual(receipt['status'], 'staging-requested')
        self.assertFalse(receipt['credentialsStoredLocally'])
        code, stdout, stderr = self.cli('--rollback')
        self.assertEqual((code, stderr), (0, ''))
        self.assertEqual(json.loads(stdout)['remoteActions'], 0)
        self.real_subprocess.assert_not_called()

    def test_receipt_write_failure_prevents_even_staging_ssh(self):
        transport, runner = self.transport()
        with patch.object(deploy, 'write_receipt', side_effect=OSError('synthetic fixture storage failure')), \
                self.assertRaises(OSError):
            self.run_apply(transport)
        self.assertEqual(runner.calls, [])
        self.real_subprocess.assert_not_called()

    def test_apply_full_fake_sequence_approves_plan_then_initializes_then_activates(self):
        transport, runner = self.transport(require_early_receipt=True)
        self.run_apply(transport)
        self.assertEqual(runner.phases, ['plan', 'prepare', 'activate'])
        receipt = deploy.read_receipt()
        self.assertEqual((receipt['status'], receipt['candidateSha256'], receipt['serverStateSha256']),
                         ('active', CANDIDATE_SHA, STATE_SHA))
        self.assertEqual(receipt['unsignedBusinessStatus'], 401)
        tty_index = next(index for index, call in enumerate(runner.calls) if '-tt' in call['argv'])
        prepare_index = next(index for index, call in enumerate(runner.calls) if call.get('phase') == 'prepare')
        activate_index = next(index for index, call in enumerate(runner.calls) if call.get('phase') == 'activate')
        self.assertLess(prepare_index, tty_index)
        self.assertLess(tty_index, activate_index)
        for call in runner.calls:
            self.assert_secure_command(call['argv'])
        scp = [call for call in runner.calls if call['argv'][0] == '/usr/bin/scp']
        self.assertEqual(len(scp), 4)
        self.assertEqual({call['argv'][-1].rsplit('/', 1)[-1] for call in scp},
                         {'portrait-server', 'portrait-studio.service', 'library.tar.gz', 'library.manifest.json'})
        for call in scp:
            self.assertTrue(call['argv'][-1].startswith(deploy.TARGET + ':/tmp/portrait-platform-stage-' + DEPLOYMENT_ID + '/'))
        for call in runner.calls:
            if 'phase' in call:
                words = shlex.split(call['argv'][-1])
                self.assertEqual(words[:4], ['sudo', '-n', 'python3', '-'])
                self.assertIsInstance(call['kwargs']['input'], bytes)
                self.assertIn(b'Reviewed code integrity failed', call['kwargs']['input'])
                if call['phase'] in ('prepare', 'activate'):
                    self.assertEqual(words[words.index('--approval') + 1], CANDIDATE_SHA)
        self.real_subprocess.assert_not_called()

    def test_interrupted_prepare_retains_owned_receipt_without_admin_or_activation(self):
        transport, runner = self.transport(require_early_receipt=True, fail_phase='prepare')
        with self.assertRaisesRegex(deploy.DeliveryError, 'requested SSH phase') as raised:
            self.run_apply(transport)
        self.assertNotIn('PRIVATE_SYNTHETIC', str(raised.exception))
        self.assertEqual(runner.phases, ['plan', 'prepare'])
        self.assertFalse(any('-tt' in call['argv'] for call in runner.calls))
        self.assertEqual(deploy.read_receipt()['status'], 'preparation-requested')

    def test_every_remote_interruption_retains_private_owned_receipt(self):
        expected = {'staging': 'staging-requested', 'upload': 'staging-requested',
                    'plan': 'staging-requested', 'init-admin': 'awaiting-admin-initialization',
                    'activate': 'awaiting-admin-initialization'}
        for operation, status in expected.items():
            with self.subTest(operation=operation):
                if self.receipt.exists():
                    self.receipt.unlink()
                transport, runner = self.transport(require_early_receipt=True, fail_phase=operation)
                with self.assertRaises(deploy.DeliveryError) as raised:
                    self.run_apply(transport)
                self.assertNotIn('PRIVATE_SYNTHETIC', str(raised.exception))
                receipt = deploy.read_receipt()
                self.assertEqual(receipt['status'], status)
                self.assertEqual(receipt['deploymentId'], DEPLOYMENT_ID)
                self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)
                self.assertFalse(receipt['credentialsStoredLocally'])
                self.assertTrue(runner.calls)
        self.real_subprocess.assert_not_called()

    def test_receipt_conflicts_and_failed_replace_preserve_original_and_clean_temporary(self):
        receipt = self.write_active_receipt()
        original = self.receipt.read_bytes()
        with self.assertRaises(deploy.DeliveryError):
            deploy.write_receipt(receipt)
        with self.assertRaises(deploy.DeliveryError):
            deploy.write_receipt({**receipt, 'deploymentId': 'f' * 32}, replace=True)
        with patch.object(deploy.os, 'fsync', side_effect=OSError('synthetic fixture fsync failure')), self.assertRaises(OSError):
            deploy.write_receipt({**receipt, 'status': 'rolled-back'}, replace=True)
        self.assertEqual(self.receipt.read_bytes(), original)
        self.assertEqual(list(self.receipt.parent.glob('.portrait-platform-receipt-*')), [])
        self.real_subprocess.assert_not_called()

    def test_wrong_plan_and_activation_receipts_are_not_success(self):
        for phase, field, bad in [('plan', 'endpoint', 'https://other.invalid/'),
                                  ('plan', 'candidatePath', '/tmp/other-candidate'),
                                  ('plan', 'existingRoutesUnchanged', False),
                                  ('plan', 'publicBlock', 'unreviewed block'),
                                  ('activate', 'unsignedBusinessStatus', 200),
                                  ('activate', 'existingCaddyAuthenticationUnchanged', False)]:
            with self.subTest(phase=phase, field=field):
                if self.receipt.exists():
                    self.receipt.unlink()
                transport, runner = self.transport(require_early_receipt=True)
                runner.overrides[phase] = {field: bad}
                with self.assertRaises(deploy.DeliveryError):
                    self.run_apply(transport)
                self.assertNotEqual(deploy.read_receipt()['status'], 'active')
                if phase == 'plan':
                    self.assertEqual(runner.phases, ['plan'])

    def test_existing_receipt_or_broken_symlink_stops_apply_without_remote(self):
        self.write_active_receipt()
        before = self.receipt.read_bytes()
        with patch.object(deploy, 'user_tty'), self.assertRaises(deploy.DeliveryError):
            deploy.apply(self.archive)
        self.assertEqual(self.receipt.read_bytes(), before)
        self.receipt.unlink()
        self.receipt.symlink_to(self.root / 'missing-receipt')
        with patch.object(deploy, 'user_tty'), self.assertRaises(deploy.DeliveryError):
            deploy.apply(self.archive)
        self.real_subprocess.assert_not_called()

    def assert_secure_command(self, command):
        self.assertIsInstance(command, list)
        self.assertTrue(all(isinstance(item, str) for item in command))
        self.assertEqual(command[1:1 + len(deploy.SSH_OPTIONS)], deploy.SSH_OPTIONS)
        options = command[1:1 + len(deploy.SSH_OPTIONS)]
        for required in ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
                         'ForwardAgent=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no',
                         'RemoteCommand=none', 'SendEnv=-*', 'ConnectTimeout=10']:
            self.assertIn(required, options)
        self.assertFalse(any(('SendEnv' in item and item != 'SendEnv=-*') or
                             'SetEnv' in item or 'ProxyCommand' in item for item in command))
        if command[0] == '/usr/bin/ssh':
            target_index = 1 + len(deploy.SSH_OPTIONS) + (1 if '-tt' in command else 0)
            self.assertEqual(command[target_index], 'ubuntu@18.180.65.241')

    def test_fake_transport_requires_private_canonical_sentinel_and_no_network_runner(self):
        runner = NoNetworkRunner(self)
        with self.assertRaises(deploy.DeliveryError):
            deploy.Transport(test_mode=True, test_root=self.root, runner=lambda *args, **kwargs: None)
        sentinel = self.root / '.portrait-platform-test-only'
        sentinel.write_bytes(b'wrong sentinel\n')
        with self.assertRaises(deploy.DeliveryError):
            deploy.Transport(test_mode=True, test_root=self.root, runner=runner)
        sentinel.write_bytes(b'no-network\n')
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / '.portrait-platform-test-only').write_bytes(b'no-network\n')
        with self.assertRaises(deploy.DeliveryError):
            deploy.Transport(test_mode=True, test_root=nested, runner=runner)
        self.assertEqual(runner.calls, [])
        self.real_subprocess.assert_not_called()

    def test_production_transport_refuses_injected_runner_or_test_root(self):
        for kwargs in [{'runner': NoNetworkRunner(self)}, {'test_root': self.root}]:
            with self.subTest(kwargs=tuple(kwargs)), self.assertRaises(deploy.DeliveryError):
                deploy.Transport(**kwargs)
        self.real_subprocess.assert_not_called()

    def test_init_admin_has_fixed_ssh_tty_inherited_stdio_and_sanitized_environment(self):
        # These are explicit synthetic redaction markers, never credentials.
        blocked = ['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY',
                   'PORTRAIT_STUDIO_ADMIN_PASSWORD', 'PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH']
        runner = Mock(return_value=subprocess.CompletedProcess([], 0, stdout=None))
        with patch.dict(os.environ, {name: 'SYNTHETIC_REDACTION_FIXTURE' for name in blocked}), \
                patch.object(deploy.subprocess, 'run', runner):
            deploy.Transport().initialize_admin()
        command = runner.call_args.args[0]
        kwargs = runner.call_args.kwargs
        self.assert_secure_command(command)
        self.assertIn('-tt', command)
        self.assertEqual(shlex.split(command[-1]), ['sudo', '-n', '-u', 'ubuntu', '--',
                         deploy.SERVER_BINARY, 'init-admin', '-auth-file', deploy.ADMIN_FILE])
        self.assertNotIn('input', kwargs)
        self.assertNotIn('stdin', kwargs)
        self.assertNotIn('stdout', kwargs)
        self.assertNotIn('stderr', kwargs)
        self.assertNotIn('capture_output', kwargs)
        self.assertFalse(any(name in kwargs['env'] for name in blocked))
        self.assertNotIn('SYNTHETIC_REDACTION_FIXTURE', ' '.join(command))
        self.assertFalse(kwargs['check'])
        self.real_subprocess.assert_not_called()

    def test_tty_transport_rejects_input_and_capture_before_runner(self):
        transport, runner = self.transport()
        for kwargs in [{'input': b'not-a-password'}, {'capture': True}]:
            with self.subTest(kwargs=tuple(kwargs)), self.assertRaises(deploy.DeliveryError):
                transport.execute(['/usr/bin/ssh'], tty=True, **kwargs)
        self.assertEqual(runner.calls, [])

    def test_phase_rejects_bad_bounded_json_without_printing_remote_output(self):
        payload = deploy.verify_payload(self.archive)
        for raw in [None, 'text', b'x' * 65537, b'[]', b'{"a":1,"a":2}', b'{"a":Infinity}', b'{bad']:
            with self.subTest(kind=type(raw).__name__, size=len(raw) if raw is not None else 0):
                runner = Mock(no_network=True, return_value=subprocess.CompletedProcess([], 0, stdout=raw))
                transport = deploy.Transport(test_mode=True, test_root=self.root, runner=runner)
                with self.assertRaises(deploy.DeliveryError):
                    transport.phase(payload, ['--phase', 'plan'])
                self.assertEqual(runner.call_count, 1)
                self.assert_secure_command(runner.call_args.args[0])

    def test_rollback_default_is_fixed_receipt_preview_with_zero_remote_or_payload_reads(self):
        self.write_active_receipt()
        before = self.tree_bytes()
        with patch.object(deploy, 'verify_payload', side_effect=AssertionError('preview must not read payload')), \
                patch.object(deploy, 'Transport', side_effect=AssertionError('preview must not construct SSH transport')), \
                patch('builtins.input', side_effect=AssertionError('preview must not prompt')):
            code, stdout, stderr = self.cli('--rollback')
        self.assertEqual((code, stderr), (0, ''))
        preview = json.loads(stdout)
        self.assertEqual((preview['remoteActions'], preview['deploymentId'], preview['state']), (0, DEPLOYMENT_ID, deploy.STATE))
        self.assertTrue(preview['retainsLibraryAndAdminConfiguration'])
        self.assertEqual(self.tree_bytes(), before)
        self.real_subprocess.assert_not_called()

    def test_rollback_rejects_changed_receipt_identity_permissions_and_symlink(self):
        original = self.write_active_receipt()
        for field, value in [('target', 'other@invalid.example'), ('endpoint', 'https://other.invalid/'),
                             ('state', '/tmp/other-state'), ('deploymentId', '../bad'), ('candidateSha256', 'bad')]:
            with self.subTest(field=field):
                self.write_json(self.receipt, {**original, field: value})
                self.receipt.chmod(0o600)
                self.assertEqual(self.cli('--rollback')[0], 1)
        self.write_json(self.receipt, original)
        self.receipt.chmod(0o644)
        self.assertEqual(self.cli('--rollback')[0], 1)
        self.receipt.unlink()
        self.receipt.symlink_to(self.root / 'missing-receipt')
        self.assertEqual(self.cli('--rollback')[0], 1)
        self.real_subprocess.assert_not_called()

    def test_staging_only_receipt_previews_but_cannot_remote_rollback(self):
        self.write_active_receipt(status='staging-requested', candidateSha256=None, beforeSha256=None)
        self.assertEqual(self.cli('--rollback')[0], 0)
        transport, runner = self.transport()
        with patch.object(deploy, 'user_tty'), self.assertRaisesRegex(deploy.DeliveryError, 'Only staging'):
            deploy.rollback(apply_remote=True, transport=transport)
        self.assertEqual(runner.calls, [])

    def test_rollback_apply_requires_tty_and_exact_current_state_sha(self):
        self.write_active_receipt()
        transport, runner = self.transport()
        with patch.object(sys.stdin, 'isatty', return_value=False), self.assertRaises(deploy.DeliveryError):
            deploy.rollback(apply_remote=True, transport=transport)
        self.assertEqual(runner.calls, [])
        with patch.object(deploy, 'user_tty'), patch('builtins.input', return_value=ROLLBACK_SHA[:16]), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(deploy.DeliveryError):
            deploy.rollback(apply_remote=True, transport=transport)
        self.assertEqual(runner.phases, ['rollback-plan'])
        self.assertEqual(deploy.read_receipt()['status'], 'active')

    def test_rollback_apply_uses_exact_fixed_receipt_and_retains_configuration(self):
        self.write_active_receipt()
        transport, runner = self.transport()
        with patch.object(deploy, 'user_tty'), patch('builtins.input', return_value=ROLLBACK_SHA), \
                contextlib.redirect_stdout(io.StringIO()):
            deploy.rollback(apply_remote=True, transport=transport)
        self.assertEqual(runner.phases, ['rollback-plan', 'rollback'])
        for call in runner.calls:
            self.assert_secure_command(call['argv'])
            words = shlex.split(call['argv'][-1])
            self.assertEqual(words[words.index('--deployment-id') + 1], DEPLOYMENT_ID)
            if call['phase'] == 'rollback':
                self.assertEqual(words[words.index('--approval') + 1], ROLLBACK_SHA)
        receipt = deploy.read_receipt()
        self.assertEqual(receipt['status'], 'rolled-back')
        self.assertTrue(receipt['dataRetainedOnRollback'])
        self.assertFalse(receipt['credentialsStoredLocally'])
        self.assertEqual((receipt['state'], receipt['target']), (deploy.STATE, deploy.TARGET))
        self.real_subprocess.assert_not_called()

    def test_rollback_apply_uses_runtime_only_preflight_when_archive_is_absent(self):
        self.write_active_receipt()
        self.archive.unlink()
        self.sidecar.unlink()
        transport, runner = self.transport()
        with patch.object(deploy, 'user_tty'), patch('builtins.input', return_value=ROLLBACK_SHA), \
                contextlib.redirect_stdout(io.StringIO()):
            deploy.rollback(apply_remote=True, transport=transport)
        self.assertEqual(runner.phases, ['rollback-plan', 'rollback'])
        self.validator.inspect_archive.assert_not_called()
        self.assertEqual(deploy.read_receipt()['status'], 'rolled-back')
        self.real_subprocess.assert_not_called()

    def test_rollback_wrong_plan_or_completion_preserves_active_receipt(self):
        for phase, field in [('rollback-plan', 'state'), ('rollback-plan', 'deploymentId'),
                             ('rollback', 'deploymentId'), ('rollback', 'dataRetained'),
                             ('rollback', 'privateAdminConfigurationRetained')]:
            with self.subTest(phase=phase, field=field):
                if self.receipt.exists():
                    self.receipt.unlink()
                self.write_active_receipt()
                transport, runner = self.transport()
                runner.overrides[phase] = {field: False}
                with patch.object(deploy, 'user_tty'), patch('builtins.input', return_value=ROLLBACK_SHA), \
                        contextlib.redirect_stdout(io.StringIO()), self.assertRaises(deploy.DeliveryError):
                    deploy.rollback(apply_remote=True, transport=transport)
                self.assertEqual(deploy.read_receipt()['status'], 'active')

    def test_conflicting_modes_and_rollback_archive_override_are_offline_errors(self):
        for args in [('--prepare', '--apply'), ('--prepare', '--rollback'),
                     ('--seal', '--apply'), ('--seal', '--rollback'),
                     ('--rollback', '--archive', str(self.root / 'other-archive'))]:
            with self.subTest(args=args):
                code, _, _ = self.cli(*args)
                self.assertEqual(code, 1)
                self.real_subprocess.assert_not_called()
                self.assertFalse(self.receipt.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
