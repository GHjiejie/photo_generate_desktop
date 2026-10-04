#!/usr/bin/env python3
"""Single user-run fixed-admin deployment entry. Default: offline checks only.

--apply requires the user's real TTY and exact public SHA approvals. The only
password prompt comes from Go in a separate inherited SSH TTY. --rollback alone
is an offline receipt preview; --rollback --apply performs guarded restoration.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import types
import uuid

TARGET = 'ubuntu@18.180.65.241'
PUBLIC_URL = 'https://portrait-18-180-65-241.sslip.io/portrait-studio/'
STATE = '/home/ubuntu/portrait-studio/evidence/platform-deployment-state.json'
ADMIN_FILE = '/home/ubuntu/portrait-studio/config/admin-auth.json'
SERVER_BINARY = '/home/ubuntu/portrait-studio/bin/portrait-server'
RELEASE = 'Portrait-Studio-Server-platform-auth-20261004-r1'
RELEASE_VERSION = 'platform-auth-20261004-r1'
ROOT = Path(__file__).resolve().parents[3]
DIRECTORY = 'server/deploy/platform_admin/'
MANIFEST = ROOT / DIRECTORY / 'manifest.json'
DEFAULT_ARCHIVE = ROOT / 'server/dist/Portrait-Studio-Library-100-r3.tar.gz'
DEFAULT_RELEASE = ROOT / 'server/dist' / RELEASE
RECEIPT = ROOT / 'server/dist/portrait-studio-platform-admin-receipt.json'
HASH = re.compile(r'^[0-9a-f]{64}$')
ID = re.compile(r'^[0-9a-f]{32}$')
BINARY_SHA = '6709933dde619ec7300bfa42ac1bf4f05e0d78d93afc7e23a91be122f1d43b28'
RELEASE_MANIFEST_SHA = 'febe878ec0b192e9cb6529205674c72c062d935e6ec4dc6aab71d6ca2bdef179'
ARCHIVE_SHA = '390cc75dde3c6f44aad0e12ff6a840423ff1199fb9be6867c7b3678e5d2d0799'
SIDECAR_SHA = '752120a072a348add59ff06024649dcc841375a4e7b018b8c3e6a4fcf3630f76'
RUNTIME_FILES = ('deploy_from_mac.py', 'deploy_server.py', 'archive_validation.py', 'caddy_review.py', 'portrait-studio.service')
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no', '-o', 'RemoteCommand=none', '-o', 'SendEnv=-*', '-o', 'ConnectTimeout=10']


class DeliveryError(Exception):
    """Safe diagnostics only; never include subprocess output or credentials."""


def require(condition, message):
    if not condition:
        raise DeliveryError(message)


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'Delivery metadata has a duplicate key.')
        value[key] = item
    return value


def json_bytes(raw):
    try:
        value = json.loads(raw.decode(), object_pairs_hook=strict_object,
            parse_constant=lambda _: (_ for _ in ()).throw(DeliveryError('Non-finite delivery metadata.')))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise DeliveryError('Malformed delivery metadata.') from exc
    require(isinstance(value, dict), 'Delivery metadata must be an object.')
    return value


def snapshot(path, maximum):
    path = Path(path).absolute()
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode), 'Delivery path contains a symbolic link.')
        require(current == path or stat.S_ISDIR(info.st_mode), 'Delivery ancestor is not a directory.')
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum,
            'Delivery file is not bounded, regular and unique: ' + path.name)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as source:
        opened = os.fstat(source.fileno())
        raw = source.read(maximum + 1)
        after = os.fstat(source.fileno())
    latest = path.lstat()
    key = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(len(raw) == before.st_size and key(before) == key(opened) == key(after) == key(latest), 'Delivery file changed while reading.')
    return {'path': path, 'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw), 'bytes': raw}


def fingerprint(path, maximum):
    # Streaming for the reusable 227 MB archive, no copy of it in Python memory.
    path = Path(path).absolute()
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        require(not stat.S_ISLNK(info.st_mode) and (current == path or stat.S_ISDIR(info.st_mode)), 'Delivery path is unsafe.')
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= maximum, 'Archive size or type is invalid.')
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as source:
        opened = os.fstat(source.fileno())
        digest = hashlib.sha256()
        total = 0
        for chunk in iter(lambda: source.read(1 << 20), b''):
            total += len(chunk)
            require(total <= before.st_size, 'Archive grew while hashing.')
            digest.update(chunk)
        after = os.fstat(source.fileno())
    latest = path.lstat()
    key = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(key(before) == key(opened) == key(after) == key(latest), 'Archive changed while hashing.')
    return {'path': path, 'sha256': digest.hexdigest(), 'size': before.st_size}


def pure_module(name, raw):
    module = types.ModuleType(name)
    # The bounded archive helper has no imports from other local code.
    exec(compile(raw, '<verified-' + name + '>', 'exec'), module.__dict__)
    return module


def verify_release(release_dir):
    require(release_dir == ROOT / 'server/dist' / RELEASE, 'Release path is fixed to the reviewed version.')
    raw = snapshot(release_dir / 'release-manifest.json', 32 << 20)
    require(raw['sha256'] == RELEASE_MANIFEST_SHA, 'Release manifest does not match the reviewed Go delivery.')
    manifest = json_bytes(raw['bytes'])
    binary = snapshot(release_dir / 'bin/portrait-server', 64 << 20)
    require(manifest.get('schemaVersion') == 1 and manifest.get('releaseVersion') == RELEASE_VERSION and
            manifest.get('binary', {}).get('path') == 'bin/portrait-server' and
            manifest['binary'].get('os') == 'linux' and manifest['binary'].get('arch') == 'amd64' and
            manifest['binary'].get('static') is True and binary['sha256'] == BINARY_SHA and
            binary['size'] == manifest['binary'].get('size') and manifest['binary'].get('sha256') == BINARY_SHA,
            'Go target/version/static binary contract differs.')
    files = manifest.get('files')
    require(isinstance(files, dict), 'Release file map is invalid.')
    for relative, expected in files.items():
        require(isinstance(relative, str) and re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', relative) and
                '..' not in relative.split('/') and isinstance(expected, dict), 'Release path metadata is invalid.')
        actual = snapshot(release_dir / relative, 64 << 20)
        require(actual['size'] == expected.get('size') and actual['sha256'] == expected.get('sha256'), 'Go release file changed: ' + relative)
    library = manifest.get('library')
    require(isinstance(library, dict) and library.get('archiveSha256') == ARCHIVE_SHA and
            library.get('manifestSha256') == SIDECAR_SHA and library.get('count') == 100 and
            library.get('revision') == 3 and library.get('external') is True, 'Release library binding differs.')
    return binary, raw


def seal_manifest(release_dir=DEFAULT_RELEASE, archive=DEFAULT_ARCHIVE):
    """Offline release-builder helper. It never connects or initializes auth."""
    binary, release_manifest = verify_release(Path(release_dir))
    files = {DIRECTORY + name: snapshot(ROOT / DIRECTORY / name, 2 << 20) for name in RUNTIME_FILES}
    validator = pure_module('portrait_archive_seal', files[DIRECTORY + 'archive_validation.py']['bytes'])
    validator.check_static_elf(binary['bytes'])
    archive_info = fingerprint(archive, 1 << 30)
    sidecar = snapshot(str(archive_info['path']) + '.manifest.json', 32 << 20)
    require(archive_info['sha256'] == ARCHIVE_SHA and sidecar['sha256'] == SIDECAR_SHA, 'Reusable library archive differs from reviewed pins.')
    validator.inspect_archive(archive_info['path'], json_bytes(sidecar['bytes']))
    files['server/dist/' + RELEASE + '/bin/portrait-server'] = binary
    files['server/dist/' + RELEASE + '/release-manifest.json'] = release_manifest
    manifest = {'schemaVersion': 2, 'target': TARGET, 'endpoint': PUBLIC_URL, 'releaseVersion': RELEASE_VERSION,
        'files': {path: {key: entry[key] for key in ('size', 'sha256')} for path, entry in sorted(files.items())},
        'library': {'archiveSha256': ARCHIVE_SHA, 'archiveSize': archive_info['size'], 'manifestSha256': SIDECAR_SHA,
            'count': 100, 'revision': 3, 'root': 'photo_repo', 'external': True},
        'authentication': {'username': 'admin', 'initialization': 'separate-user-ssh-tty', 'passwordInScript': False},
        'caddy': {'newHostOnly': True, 'existingAuthenticationUnchanged': True, 'approval': 'exact-candidate-sha256'}}
    data = json.dumps(manifest, indent=2, sort_keys=True).encode() + b'\n'
    temporary = MANIFEST.with_name('.manifest-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, MANIFEST)
    finally:
        if temporary.exists():
            temporary.unlink()
    return manifest


def verify_payload(archive=DEFAULT_ARCHIVE, *, runtime_only=False):
    manifest = json_bytes(snapshot(MANIFEST, 32 << 20)['bytes'])
    require(manifest.get('schemaVersion') == 2 and manifest.get('target') == TARGET and
            manifest.get('endpoint') == PUBLIC_URL and manifest.get('releaseVersion') == RELEASE_VERSION,
            'Deployment manifest identity is invalid.')
    names = {DIRECTORY + name for name in RUNTIME_FILES} | {'server/dist/' + RELEASE + '/bin/portrait-server', 'server/dist/' + RELEASE + '/release-manifest.json'}
    require(isinstance(manifest.get('files'), dict) and set(manifest['files']) == names, 'Deployment runtime file map is invalid.')
    payload = {}
    for relative in sorted(names):
        entry = manifest['files'][relative]
        require(isinstance(entry, dict) and HASH.fullmatch(str(entry.get('sha256', ''))), 'Deployment file pin is invalid.')
        actual = snapshot(ROOT / relative, 64 << 20)
        require(actual['sha256'] == entry['sha256'] and actual['size'] == entry.get('size'), 'Reviewed deployment file changed: ' + relative)
        payload[relative] = actual
    binary, release_manifest = verify_release(DEFAULT_RELEASE)
    require(binary['sha256'] == payload['server/dist/' + RELEASE + '/bin/portrait-server']['sha256'] and
            release_manifest['sha256'] == payload['server/dist/' + RELEASE + '/release-manifest.json']['sha256'], 'Go release changed during verification.')
    validator = pure_module('portrait_archive_verify', payload[DIRECTORY + 'archive_validation.py']['bytes'])
    validator.check_static_elf(binary['bytes'])
    if runtime_only:
        # Rollback retains server data and needs no local seed tar or upload.
        return payload
    archive_info = fingerprint(archive, 1 << 30)
    sidecar = snapshot(str(archive_info['path']) + '.manifest.json', 32 << 20)
    pins = manifest.get('library')
    require(isinstance(pins, dict) and pins.get('archiveSha256') == ARCHIVE_SHA == archive_info['sha256'] and
            pins.get('manifestSha256') == SIDECAR_SHA == sidecar['sha256'] and pins.get('archiveSize') == archive_info['size'] and
            pins.get('count') == 100 and pins.get('revision') == 3 and pins.get('root') == 'photo_repo', 'Library archive/sidecar identity differs.')
    try:
        validator.inspect_archive(archive_info['path'], json_bytes(sidecar['bytes']))
    except validator.DeploymentError as exc:
        raise DeliveryError('Full library archive validation failed.') from exc
    payload.update(archive=archive_info, sidecar=sidecar)
    return payload


def server_script(payload):
    """Execute verified snapshots over Python stdin, never a staged /tmp script."""
    modules = []
    for name in ('archive_validation', 'caddy_review', 'deploy_server'):
        entry = payload[DIRECTORY + name + '.py']
        modules.append((name, base64.b64encode(entry['bytes']).decode(), entry['sha256']))
    unit = payload[DIRECTORY + 'portrait-studio.service']['bytes']
    preamble = '''import base64,hashlib,sys,types\nmodules = %r\nfor name,data,pin in modules:\n raw=base64.b64decode(data,validate=True)\n if hashlib.sha256(raw).hexdigest()!=pin: raise RuntimeError('Reviewed code integrity failed')\n mod=types.ModuleType(name);sys.modules[name]=mod\n exec(compile(raw,'<reviewed-'+name+'>','exec'),mod.__dict__)\nif sys.modules['deploy_server'].EXPECTED_UNIT!=base64.b64decode(%r): raise RuntimeError('Reviewed unit integrity failed')\ntry:\n sys.modules['deploy_server'].main()\nexcept Exception:\n print('Remote phase stopped safely; private retained state requires review.',file=sys.stderr)\n sys.exit(1)\n''' % (modules, base64.b64encode(unit).decode())
    return preamble.encode()


class Transport:
    """Only production SSH effect boundary; fake runner requires explicit fixture."""
    def __init__(self, *, test_mode=False, test_root=None, runner=None):
        self.test_mode = test_mode
        if test_mode:
            root = Path(test_root or '').resolve()
            require(root.is_dir() and root.parent in (Path('/tmp'), Path('/private/tmp')) and
                    (root / '.portrait-platform-test-only').read_bytes() == b'no-network\n', 'Explicit private test fixture is required.')
            require(getattr(runner, 'no_network', False) is True, 'Test mode requires a fake runner with no network.')
            self.runner = runner
        else:
            require(runner is None and test_root is None, 'Production transport does not accept injected commands.')
            self.runner = subprocess.run

    def execute(self, argv, *, input=None, capture=False, tty=False):
        # SSH cannot inherit passwords from environment forwarding or askpass.
        env = {key: value for key, value in os.environ.items() if key not in
               ('SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DISPLAY', 'PORTRAIT_STUDIO_ADMIN_PASSWORD', 'PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH')}
        kwargs = {'check': False, 'env': env}
        if tty:
            require(input is None and not capture, 'Admin TTY may never be piped or captured.')
        else:
            kwargs.update(input=input, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE)
        result = self.runner(argv, **kwargs)
        require(result.returncode == 0, 'A requested SSH phase stopped; retained private server state requires review.')
        return result.stdout if capture else None

    def phase(self, payload, args):
        command = ['/usr/bin/ssh', *SSH_OPTIONS, TARGET,
                   shlex.join(['sudo', '-n', 'python3', '-', *args])]
        raw = self.execute(command, input=server_script(payload), capture=True)
        require(isinstance(raw, bytes) and len(raw) <= 65536, 'Remote phase result is invalid.')
        return json_bytes(raw)

    def initialize_admin(self):
        command = ['/usr/bin/ssh', *SSH_OPTIONS, '-tt', TARGET,
            shlex.join(['sudo', '-n', '-u', 'ubuntu', '--', SERVER_BINARY, 'init-admin', '-auth-file', ADMIN_FILE])]
        self.execute(command, tty=True)


def user_tty():
    require(sys.stdin.isatty() and sys.stdout.isatty(), '--apply requires the user to run this entry personally in an interactive terminal.')


def confirm_sha(label, digest):
    require(HASH.fullmatch(digest or ''), 'Approval SHA is invalid.')
    entered = input(label + '\nType the complete SHA256 shown above to continue: ').strip()
    require(entered == digest, 'Exact SHA approval was not supplied; no activation was requested.')


def write_receipt(value, *, replace=False):
    raw = json.dumps(value, sort_keys=True, indent=2).encode() + b'\n'
    require(RECEIPT.parent.is_dir(), 'Receipt directory is missing.')
    temporary = RECEIPT.with_name('.portrait-platform-receipt-' + uuid.uuid4().hex)
    if not replace:
        require(not os.path.lexists(RECEIPT), 'An existing receipt requires review before a new installation.')
    else:
        previous = snapshot(RECEIPT, 1 << 20)
        old = json_bytes(previous['bytes'])
        require(old.get('deploymentId') == value['deploymentId'], 'Local receipt identity changed.')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        if replace:
            require(snapshot(RECEIPT, 1 << 20)['sha256'] == previous['sha256'], 'Receipt changed before replacement.')
            os.replace(temporary, RECEIPT)
        else:
            # Link is atomic and will not overwrite a competing receipt.
            os.link(temporary, RECEIPT)
            temporary.unlink()
        directory = os.open(RECEIPT.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_receipt():
    entry = snapshot(RECEIPT, 1 << 20)
    info = entry['path'].lstat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, 'Local receipt ownership/permissions changed.')
    value = json_bytes(entry['bytes'])
    require(value.get('schemaVersion') == 2 and value.get('target') == TARGET and value.get('endpoint') == PUBLIC_URL and
            value.get('state') == STATE and ID.fullmatch(str(value.get('deploymentId', ''))) and
            (HASH.fullmatch(str(value.get('candidateSha256', ''))) or
             value.get('candidateSha256') is None and value.get('status') == 'staging-requested'), 'Local receipt fixed identity is invalid.')
    return value


def apply(archive=DEFAULT_ARCHIVE, transport=None):
    payload = verify_payload(archive)
    user_tty()
    require(not os.path.lexists(RECEIPT), 'An existing receipt requires review; refusing another installation.')
    transport = transport or Transport()
    deployment_id = uuid.uuid4().hex
    stage = '/tmp/portrait-platform-stage-' + deployment_id
    plan_dir = '/tmp/portrait-platform-plan-' + deployment_id
    receipt = {'schemaVersion': 2, 'target': TARGET, 'endpoint': PUBLIC_URL, 'state': STATE, 'deploymentId': deployment_id,
               'candidateSha256': None, 'beforeSha256': None, 'staging': stage, 'privatePlan': plan_dir,
               'status': 'staging-requested', 'dataRetainedOnRollback': True, 'credentialsStoredLocally': False}
    # Persist the owned transaction identity before even the first remote write.
    write_receipt(receipt)
    transport.execute(['/usr/bin/ssh', *SSH_OPTIONS, TARGET, shlex.join(['sh', '-c', 'umask 077; mkdir -- ' + shlex.quote(stage)])])
    staged = {'portrait-server': payload['server/dist/' + RELEASE + '/bin/portrait-server'],
        'portrait-studio.service': payload[DIRECTORY + 'portrait-studio.service'], 'library.tar.gz': payload['archive'], 'library.manifest.json': payload['sidecar']}
    for filename, entry in staged.items():
        transport.execute(['/usr/bin/scp', *SSH_OPTIONS, str(entry['path']), TARGET + ':' + stage + '/' + filename])
    pins = {'binarySha256': staged['portrait-server']['sha256'], 'unitSha256': staged['portrait-studio.service']['sha256'],
            'manifestSha256': staged['library.manifest.json']['sha256'], 'archiveSha256': staged['library.tar.gz']['sha256']}
    plan = transport.phase(payload, ['--phase', 'plan', '--deployment-id', deployment_id, '--staging', stage, '--plan', plan_dir,
                                    '--pins', json.dumps(pins, sort_keys=True, separators=(',', ':'))])
    require(plan.get('status') == 'review-required' and plan.get('deploymentId') == deployment_id and
            plan.get('endpoint') == PUBLIC_URL and plan.get('candidatePath') == plan_dir + '/Caddyfile.candidate' and
            plan.get('existingRoutesUnchanged') is True and HASH.fullmatch(str(plan.get('beforeSha256', ''))) and
            HASH.fullmatch(str(plan.get('candidateSha256', ''))), 'Remote reviewed plan identity differs.')
    caddy = pure_module('portrait_caddy_public', payload[DIRECTORY + 'caddy_review.py']['bytes'])
    require(plan.get('publicBlock') == caddy.PUBLIC_BLOCK, 'Public candidate block differs from the reviewed new host.')
    print('Private server candidate: ' + plan['candidatePath'])
    print('Current Caddy SHA256: ' + plan['beforeSha256'])
    print('Candidate SHA256: ' + plan['candidateSha256'])
    print('Only this new public block will be appended; existing sites/authentication remain unchanged:\n' + plan['publicBlock'])
    confirm_sha('Approve the exact new-host candidate:', plan['candidateSha256'])
    receipt.update(candidateSha256=plan['candidateSha256'], beforeSha256=plan['beforeSha256'], status='preparation-requested')
    write_receipt(receipt, replace=True)
    prepared = transport.phase(payload, ['--phase', 'prepare', '--deployment-id', deployment_id, '--plan', plan_dir, '--approval', plan['candidateSha256']])
    require(prepared.get('status') == 'awaiting-admin-initialization' and prepared.get('deploymentId') == deployment_id and
            prepared.get('state') == STATE and prepared.get('count') == 100 and prepared.get('revision') == 3,
            'Prepared installation identity differs.')
    receipt['status'] = 'awaiting-admin-initialization'
    write_receipt(receipt, replace=True)
    print('Enter your new admin password privately in the next remote Go TTY prompt. The script does not read it.', flush=True)
    transport.initialize_admin()
    activated = transport.phase(payload, ['--phase', 'activate', '--deployment-id', deployment_id, '--approval', plan['candidateSha256']])
    require(activated.get('status') == 'active' and activated.get('deploymentId') == deployment_id and activated.get('state') == STATE and
            activated.get('count') == 100 and activated.get('revision') == 3 and activated.get('initialized') is True and
            activated.get('unsignedBusinessStatus') == 401 and activated.get('existingCaddyAuthenticationUnchanged') is True and
            HASH.fullmatch(str(activated.get('stateSha256', ''))), 'Activation receipt is not fully verified.')
    receipt.update(status='active', serverStateSha256=activated['stateSha256'], initialized=True, unsignedBusinessStatus=401)
    write_receipt(receipt, replace=True)
    print(json.dumps({'status': 'active', 'endpoint': PUBLIC_URL, 'count': 100, 'revision': 3, 'receipt': str(RECEIPT)}))


def rollback(*, apply_remote=False, transport=None):
    receipt = read_receipt()
    if not apply_remote:
        print(json.dumps({'status': 'local-rollback-preview', 'remoteActions': 0, 'deploymentId': receipt['deploymentId'],
            'state': STATE, 'retainsLibraryAndAdminConfiguration': True, 'command': 'python3 server/deploy/platform_admin/deploy_from_mac.py --rollback --apply'}, indent=2))
        return
    payload = verify_payload(runtime_only=True)
    user_tty()
    require(receipt.get('candidateSha256') is not None, 'Only staging was requested; no owned installation state is confirmed. Private server staging requires operator review.')
    transport = transport or Transport()
    plan = transport.phase(payload, ['--phase', 'rollback-plan', '--deployment-id', receipt['deploymentId']])
    require(plan.get('status') == 'rollback-review-required' and plan.get('deploymentId') == receipt['deploymentId'] and
            plan.get('state') == STATE and plan.get('dataRetained') is True and plan.get('privateAdminConfigurationRetained') is True and
            HASH.fullmatch(str(plan.get('rollbackApprovalSha256', ''))), 'Rollback plan identity differs.')
    print('Rollback private state SHA256: ' + plan['rollbackApprovalSha256'])
    print('Only this installation’s unchanged owned route/service will be restored/stopped. Library and admin configuration are retained.')
    confirm_sha('Approve exact current rollback state:', plan['rollbackApprovalSha256'])
    result = transport.phase(payload, ['--phase', 'rollback', '--deployment-id', receipt['deploymentId'], '--approval', plan['rollbackApprovalSha256']])
    require(result.get('status') == 'rolled-back' and result.get('deploymentId') == receipt['deploymentId'] and
            result.get('dataRetained') is True and result.get('privateAdminConfigurationRetained') is True, 'Rollback completion receipt differs.')
    receipt['status'] = 'rolled-back'
    write_receipt(receipt, replace=True)
    print(json.dumps(result))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--seal', action='store_true', help='Offline release-builder manifest generation only')
    parser.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    args = parser.parse_args(argv)
    try:
        require(not (args.prepare and (args.apply or args.rollback or args.seal)) and
                not (args.seal and (args.apply or args.rollback)), 'Requested entry modes conflict.')
        if args.seal:
            seal_manifest(archive=args.archive)
            print(json.dumps({'status': 'offline-manifest-sealed', 'manifest': str(MANIFEST), 'remoteActions': 0}))
        elif args.rollback:
            require(args.archive == DEFAULT_ARCHIVE, 'Rollback does not accept a library override.')
            rollback(apply_remote=args.apply)
        elif args.apply:
            apply(args.archive)
        else:
            payload = verify_payload(args.archive)
            print(json.dumps({'status': 'offline-payload-verified', 'remoteActions': 0, 'target': TARGET,
                'endpoint': PUBLIC_URL, 'releaseVersion': RELEASE_VERSION, 'count': 100, 'revision': 3,
                'archive': str(payload['archive']['path']), 'archiveSha256': payload['archive']['sha256']}, indent=2))
        return 0
    except DeliveryError as exc:
        print('Deployment stopped: ' + str(exc), file=sys.stderr)
        return 1
    except Exception:
        print('Deployment stopped safely. Review retained private state; no credentials were printed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
