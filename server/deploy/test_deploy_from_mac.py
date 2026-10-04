"""Local-only deployment-wrapper tests: every subprocess call is mocked.

All payloads, manifests and receipts live in a canonical temporary directory.
The tests never execute SSH/SCP, the server script, or a real deployment.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'deploy_from_mac_under_test', Path(__file__).with_name('deploy_from_mac.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployFromMacTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='portrait-deploy-wrapper-test-')
        self.addCleanup(temporary.cleanup)
        # macOS /var is an alias; the production verifier intentionally refuses
        # symlink ancestors, so test fixture paths must be canonical.
        self.root = Path(temporary.name).resolve()
        (self.root / 'server/deploy').mkdir(parents=True)
        (self.root / 'server/dist').mkdir()
        self.files = {
            'server/deploy/deploy_server.py': b'# reviewed test bytes, never executed\n',
            'server/deploy/portrait-studio.service': b'[Service]\nExecStart=/fixture/portrait-server\n',
            'server/dist/portrait-server-linux-amd64': b'ELF fixture bytes, never executed\n',
        }
        for relative, raw in self.files.items():
            (self.root / relative).write_bytes(raw)
        # The wrapper verifies reviewed archive bytes, not raster/tar parsing;
        # importer/prepare tests cover archive structure separately.
        self.archive = self.root / 'server/dist/library fixture $(never-run).tar.gz'
        self.archive.write_bytes(b'pinned archive fixture bytes\n')
        self.sidecar = Path(str(self.archive) + '.manifest.json')
        self.library = {'count': 100, 'revision': 3,
                        'archiveSha256': self.digest(self.archive)}
        self.write_json(self.sidecar, self.library)
        self.tools_manifest = self.root / 'server/deploy/manual-deployment-manifest.json'
        self.tools = {
            'schemaVersion': 1, 'target': 'ubuntu@18.180.65.241',
            'files': {relative: {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
                      for relative, raw in self.files.items()},
            'library': {'archiveSha256': self.digest(self.archive),
                        'manifestSha256': self.digest(self.sidecar)},
        }
        self.write_json(self.tools_manifest, self.tools)
        self.receipt = self.root / 'server/dist/portrait-studio-user-deployment-receipt.json'
        for name, value in [('ROOT', self.root), ('DEFAULT_ARCHIVE', self.archive),
                            ('RECEIPT', self.receipt)]:
            patcher = patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # This applies even to tests which deliberately exercise --apply.
        run = patch.object(deploy.subprocess, 'run', side_effect=lambda args, **kwargs:
                           subprocess.CompletedProcess(args, 0, stdout=b''))
        self.run = run.start()
        self.addCleanup(run.stop)
        popen = patch.object(deploy.subprocess, 'Popen', side_effect=AssertionError(
            'A real subprocess is forbidden by deployment-wrapper tests'))
        popen.start()
        self.addCleanup(popen.stop)

    @staticmethod
    def digest(filename):
        return hashlib.sha256(Path(filename).read_bytes()).hexdigest()

    @staticmethod
    def write_json(filename, value):
        Path(filename).write_text(json.dumps(value, sort_keys=True) + '\n', encoding='utf-8')

    def cli(self, *arguments):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, 'argv', ['deploy_from_mac.py', *arguments]), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = deploy.main()
        return result, stdout.getvalue(), stderr.getvalue()

    def snapshot(self):
        return {str(file.relative_to(self.root)): file.read_bytes()
                for file in self.root.rglob('*') if file.is_file() and not file.is_symlink()}

    def refresh_sidecar_pin(self):
        self.tools['library']['manifestSha256'] = self.digest(self.sidecar)
        self.write_json(self.tools_manifest, self.tools)

    def assert_stopped_before_remote(self):
        receipt_existed = self.receipt.exists()
        receipt_bytes = self.receipt.read_bytes() if receipt_existed else None
        result, _, stderr = self.cli('--apply')
        self.assertEqual(result, 1)
        self.assertIn('Deployment stopped:', stderr)
        self.run.assert_not_called()
        self.assertEqual(self.receipt.exists(), receipt_existed)
        if receipt_existed:
            self.assertEqual(self.receipt.read_bytes(), receipt_bytes)

    def test_default_and_prepare_are_read_only_without_any_subprocess(self):
        before = self.snapshot()
        for arguments in [(), ('--prepare',), ('--prepare', '--archive', str(self.archive))]:
            with self.subTest(arguments=arguments):
                result, stdout, stderr = self.cli(*arguments)
                self.assertEqual(result, 0)
                self.assertEqual(stderr, '')
                summary = json.loads(stdout)
                self.assertEqual(summary['remoteActions'], 0)
                self.assertEqual((summary['records'], summary['revision']), (100, 3))
                self.assertEqual(summary['archiveSha256'], self.digest(self.archive))
                self.assertEqual(summary['target'], 'ubuntu@18.180.65.241')
                self.run.assert_not_called()
                self.assertEqual(self.snapshot(), before)

    def test_archive_byte_change_blocks_apply_before_remote(self):
        self.archive.write_bytes(self.archive.read_bytes() + b'tamper')
        self.assert_stopped_before_remote()

    def test_sidecar_hash_change_blocks_even_identical_semantic_data(self):
        self.sidecar.write_text(json.dumps(self.library, indent=4) + '\n', encoding='utf-8')
        self.assert_stopped_before_remote()

    def test_wrong_archive_hash_count_revision_and_delivery_pins_stop_early(self):
        original_library = dict(self.library)
        original_tools = json.loads(json.dumps(self.tools))
        mutations = [
            ('count', 99), ('count', '100'), ('revision', 2), ('revision', '3'),
            ('archiveSha256', '0' * 64),
        ]
        for field, value in mutations:
            with self.subTest(field=field, value=value):
                self.library = {**original_library, field: value}
                self.tools = json.loads(json.dumps(original_tools))
                self.write_json(self.sidecar, self.library)
                self.refresh_sidecar_pin()
                self.assert_stopped_before_remote()
        self.library = original_library
        self.write_json(self.sidecar, self.library)
        for field in ['archiveSha256', 'manifestSha256']:
            with self.subTest(reviewed_pin=field):
                self.tools = json.loads(json.dumps(original_tools))
                self.tools['library'][field] = 'f' * 64
                self.write_json(self.tools_manifest, self.tools)
                self.assert_stopped_before_remote()

    def test_all_three_tool_byte_changes_and_missing_pins_stop_early(self):
        for relative, raw in self.files.items():
            with self.subTest(tool=relative):
                file = self.root / relative
                file.write_bytes(raw + b' changed')
                self.assert_stopped_before_remote()
                file.write_bytes(raw)
        for relative in self.files:
            with self.subTest(missing_pin=relative):
                original = self.tools['files'].pop(relative)
                self.write_json(self.tools_manifest, self.tools)
                self.assert_stopped_before_remote()
                self.tools['files'][relative] = original
                self.write_json(self.tools_manifest, self.tools)

    def test_target_and_schema_changes_cannot_redirect_remote_work(self):
        for field, value in [('target', 'attacker@other.invalid'), ('target', 'ubuntu@18.180.65.241; false'),
                             ('schemaVersion', 2)]:
            with self.subTest(field=field, value=value):
                original = self.tools[field]
                self.tools[field] = value
                self.write_json(self.tools_manifest, self.tools)
                self.assert_stopped_before_remote()
                self.tools[field] = original
                self.write_json(self.tools_manifest, self.tools)

    def test_duplicate_and_invalid_json_never_reach_remote(self):
        cases = [b'{"count":100,"count":100,"revision":3}\n', b'{not-json}\n', b'\xff\xfe']
        for raw in cases:
            with self.subTest(raw=raw):
                self.sidecar.write_bytes(raw)
                self.refresh_sidecar_pin()
                self.assert_stopped_before_remote()

    def test_invalid_manifest_object_shapes_stop_with_uniform_error(self):
        original_tools = json.loads(json.dumps(self.tools))
        original_sidecar = self.sidecar.read_bytes()
        bad_entry = json.loads(json.dumps(original_tools))
        bad_entry['files']['server/deploy/deploy_server.py'] = []
        cases = [
            ('tools-null', self.tools_manifest, None),
            ('tools-array', self.tools_manifest, []),
            ('files-null', self.tools_manifest, {**original_tools, 'files': None}),
            ('files-array', self.tools_manifest, {**original_tools, 'files': []}),
            ('entry-array', self.tools_manifest, bad_entry),
            ('library-null', self.tools_manifest, {**original_tools, 'library': None}),
            ('library-array', self.tools_manifest, {**original_tools, 'library': []}),
            ('sidecar-null', self.sidecar, None),
            ('sidecar-array', self.sidecar, []),
        ]
        for name, filename, document in cases:
            with self.subTest(case=name):
                self.tools = json.loads(json.dumps(original_tools))
                self.sidecar.write_bytes(original_sidecar)
                self.write_json(self.tools_manifest, self.tools)
                self.write_json(filename, document)
                if filename == self.sidecar:
                    self.refresh_sidecar_pin()
                self.assert_stopped_before_remote()

    def test_missing_empty_large_and_symlink_payloads_are_rejected(self):
        original = self.archive.read_bytes()
        self.archive.unlink()
        self.assert_stopped_before_remote()
        self.archive.write_bytes(b'')
        self.assert_stopped_before_remote()
        with self.archive.open('wb') as output:
            output.truncate((1 << 30) + 1)
        self.assert_stopped_before_remote()
        self.archive.unlink()
        separate = self.root / 'original-archive'
        separate.write_bytes(original)
        self.archive.symlink_to(separate)
        self.assert_stopped_before_remote()
        self.assertEqual(separate.read_bytes(), original)
        self.archive.unlink()
        self.archive.write_bytes(original)
        alias = self.root / 'directory-alias'
        alias.symlink_to(self.archive.parent, target_is_directory=True)
        with self.assertRaises(deploy.DeliveryError):
            deploy.verify_payload(alias / self.archive.name)
        self.run.assert_not_called()

    def test_verified_script_changed_before_stdin_is_rejected(self):
        reviewed = deploy.verify_payload(self.archive)
        (self.root / 'server/deploy/deploy_server.py').write_bytes(b'changed script')
        with patch.object(deploy, 'verify_payload', return_value=reviewed):
            with self.assertRaises(deploy.DeliveryError):
                deploy.apply(self.archive)
        self.run.assert_not_called()
        self.assertFalse(self.receipt.exists())

    def test_existing_or_broken_symlink_receipt_blocks_new_deployment(self):
        self.receipt.write_bytes(b'previous user receipt')
        self.assert_stopped_before_remote()
        self.assertEqual(self.receipt.read_bytes(), b'previous user receipt')
        self.receipt.unlink()
        self.receipt.symlink_to(self.root / 'absent-receipt-target')
        self.assert_stopped_before_remote()
        self.assertTrue(self.receipt.is_symlink())

    def security_options(self, command):
        self.assertIsInstance(command, list)
        self.assertTrue(all(isinstance(value, str) for value in command))
        options = [command[index + 1] for index, value in enumerate(command) if value == '-o']
        for option in ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
                       'ForwardAgent=no', 'ConnectTimeout=10']:
            self.assertIn(option, options)
        self.assertNotIn('-A', command)
        self.assertFalse(any(value in options for value in [
            'StrictHostKeyChecking=no', 'UserKnownHostsFile=/dev/null', 'ForwardAgent=yes']))

    def test_apply_uses_fixed_secure_transport_generated_stage_and_stdin_code(self):
        before = self.snapshot()
        token = uuid.UUID('12345678-1234-5678-1234-567812345678')
        with patch.object(deploy.uuid, 'uuid4', return_value=token):
            result, _, stderr = self.cli('--apply')
        self.assertEqual(result, 0)
        self.assertEqual(stderr, '')
        calls = self.run.call_args_list
        self.assertEqual(len(calls), 6)
        commands = [call.args[0] for call in calls]
        self.assertEqual([command[0] for command in commands], ['ssh', 'scp', 'scp', 'scp', 'scp', 'ssh'])
        stage = '/tmp/portrait-studio-stage-' + token.hex
        for call, command in zip(calls, commands):
            self.security_options(command)
            self.assertTrue(call.kwargs['check'])
            self.assertFalse(call.kwargs.get('shell', False))
            if command[0] == 'ssh':
                self.assertEqual(command[-2], 'ubuntu@18.180.65.241')
            else:
                self.assertTrue(command[-1].startswith('ubuntu@18.180.65.241:' + stage + '/'))
        mkdir = shlex.split(commands[0][-1])
        self.assertEqual(mkdir, ['sh', '-c', 'umask 077; mkdir -- ' + stage])
        copied_names = {Path(command[-1]).name for command in commands if command[0] == 'scp'}
        self.assertEqual(copied_names, {'portrait-server', 'portrait-studio.service',
                                      'photo-repo-100.tar.gz', 'photo-repo-100.tar.gz.manifest.json'})
        self.assertFalse(any('deploy_server.py' in command[-1] for command in commands))
        self.assertIn(str(self.archive), commands[3])
        invocation = shlex.split(commands[-1][-1])
        self.assertEqual(invocation[:6], ['sudo', '-n', 'python3', '-', '--apply', '--staging'])
        self.assertEqual(invocation[6], stage)
        self.assertEqual(invocation[invocation.index('--binary-sha256') + 1],
                         self.digest(self.root / 'server/dist/portrait-server-linux-amd64'))
        self.assertEqual(invocation[invocation.index('--unit-sha256') + 1],
                         self.digest(self.root / 'server/deploy/portrait-studio.service'))
        self.assertEqual(invocation[invocation.index('--manifest-sha256') + 1], self.digest(self.sidecar))
        self.assertEqual(calls[-1].kwargs['input'], self.files['server/deploy/deploy_server.py'])
        self.assertFalse(any(value.startswith('/tmp/') and value.endswith('.py') for value in invocation))
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt['target'], 'ubuntu@18.180.65.241')
        self.assertEqual(receipt['staging'], stage)
        self.assertEqual(receipt['state'], '/home/ubuntu/portrait-studio/evidence/deployment-state.json')
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)
        after = self.snapshot()
        after.pop(str(self.receipt.relative_to(self.root)))
        self.assertEqual(after, before)

    def test_remote_failure_stops_before_receipt_and_does_not_delete_local_data(self):
        before = self.snapshot()
        self.run.side_effect = subprocess.CalledProcessError(255, ['mocked-ssh'])
        result, _, stderr = self.cli('--apply')
        self.assertEqual(result, 1)
        self.assertIn('Deployment stopped:', stderr)
        self.assertEqual(self.run.call_count, 1)
        self.assertFalse(self.receipt.exists())
        self.assertEqual(self.snapshot(), before)

    def test_rollback_sends_reviewed_code_to_fixed_state_without_upload_or_delete(self):
        # Rollback needs the three pinned tools, not an arbitrary new archive.
        self.archive.unlink()
        self.sidecar.unlink()
        before = self.snapshot()
        result, _, stderr = self.cli('--rollback')
        self.assertEqual(result, 0)
        self.assertEqual(stderr, '')
        self.run.assert_called_once()
        command = self.run.call_args.args[0]
        self.security_options(command)
        self.assertEqual(command[0], 'ssh')
        self.assertEqual(command[-2], 'ubuntu@18.180.65.241')
        invocation = shlex.split(command[-1])
        self.assertEqual(invocation, ['sudo', '-n', 'python3', '-', '--rollback', '--state',
                                     '/home/ubuntu/portrait-studio/evidence/deployment-state.json'])
        self.assertEqual(self.run.call_args.kwargs['input'], self.files['server/deploy/deploy_server.py'])
        self.assertFalse(any(value in invocation for value in ['rm', 'rmdir', '--delete']))
        self.assertEqual(self.snapshot(), before)

    def test_unrecognized_target_state_and_combined_modes_cannot_run_remote(self):
        for arguments in [('--apply', '--target', 'other@host'),
                          ('--rollback', '--state', '/tmp/other.json'),
                          ('--apply', '--rollback')]:
            with self.subTest(arguments=arguments):
                with self.assertRaises(SystemExit) as exit_status:
                    self.cli(*arguments)
                self.assertEqual(exit_status.exception.code, 2)
                self.run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
