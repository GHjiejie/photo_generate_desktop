#!/usr/bin/env python3
"""Reviewed remote phases for a fresh fixed-admin installation.

The Mac entry supplies this program over root Python stdin. Password entry is a
separate, user-controlled SSH TTY invoking Go; this program never reads the
private admin file. A partial installation retains its library and credentials.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import platform
import pwd
import re
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

from archive_validation import (DeploymentError, HASH, MAX_BINARY, MAX_JSON,
    check_static_elf, inspect_archive, inspect_tree, no_links, read_file, require,
    sha256, strict_json, write_new)
from caddy_review import build_candidate, prove_adapted_unchanged, ReviewError

SERVICE = 'portrait-studio.service'
HOST = 'portrait-18-180-65-241.sslip.io'
PUBLIC = 'https://' + HOST + '/portrait-studio/'
LOOPBACK = 'http://127.0.0.1:4137/'
RELEASE_VERSION = 'platform-auth-20261004-r1'
STAGING = re.compile(r'^/tmp/portrait-platform-stage-[0-9a-f]{32}$')
PLAN = re.compile(r'^/tmp/portrait-platform-plan-[0-9a-f]{32}$')
ID = re.compile(r'^[0-9a-f]{32}$')
EXPECTED_UNIT = '''[Unit]
Description=Portrait Studio Go API with fixed admin authentication
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/portrait-studio
# The administrator initializes this hash-only file locally; no default secret.
Environment=PORTRAIT_STUDIO_ADMIN_USERNAME=admin
Environment=PORTRAIT_STUDIO_AUTH_FILE=/home/ubuntu/portrait-studio/config/admin-auth.json
ExecStart=/home/ubuntu/portrait-studio/bin/portrait-server -listen 127.0.0.1:4137 -data /home/ubuntu/portrait-studio/data/photo_repo -version platform-auth-20261004-r1
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ubuntu/portrait-studio/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
'''.encode()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def sync(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_replace(path, data, expected, mode, uid, gid):
    current, initial = read_file(path, MAX_JSON, uid)
    require(sha256(current) == expected and stat.S_IMODE(initial.st_mode) == mode and initial.st_gid == gid,
            'Managed configuration bytes or metadata changed; preserving it.')
    temporary = path.parent / ('.portrait-platform-' + os.urandom(16).hex())
    try:
        write_new(temporary, data, mode)
        os.chown(temporary, uid, gid, follow_symlinks=False)
        os.chmod(temporary, mode, follow_symlinks=False)
        latest, last = read_file(path, MAX_JSON, uid)
        require(sha256(latest) == expected and stat.S_IMODE(last.st_mode) == mode and last.st_gid == gid,
                'Managed configuration bytes or metadata changed before replacement.')
        os.replace(temporary, path)
        sync(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


@dataclass(frozen=True)
class Paths:
    app: Path = Path('/home/ubuntu/portrait-studio')
    caddy: Path = Path('/etc/caddy/Caddyfile')
    unit: Path = Path('/etc/systemd/system/portrait-studio.service')
    enabled: Path = Path('/etc/systemd/system/multi-user.target.wants/portrait-studio.service')
    system_roots: tuple = (Path('/etc/systemd/system'), Path('/run/systemd/system'), Path('/usr/lib/systemd/system'))

    @property
    def state(self):
        return self.app / 'evidence/platform-deployment-state.json'


class Commands:
    """Private bounded output only; subprocess text is never a diagnostic."""
    def run(self, argv, label):
        try:
            result = subprocess.run(argv, check=False, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=45,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'})
        except (OSError, subprocess.SubprocessError) as exc:
            raise DeploymentError('Required server operation failed: ' + label) from exc
        require(result.returncode == 0 and len(result.stdout) <= MAX_JSON,
                'Required server operation failed: ' + label)
        return result.stdout


class Runtime:
    def __init__(self, paths=None, commands=None, *, test_mode=False, test_root=None):
        self.paths = paths or Paths()
        self.commands = commands or Commands()
        self.test_mode = test_mode
        self.root_uid = 0
        self.owner = None
        if test_mode:
            root = Path(test_root or '').resolve()
            require(root.is_dir() and root.parent == Path('/private/tmp') or
                    root.is_dir() and root.parent == Path('/tmp'), 'Test root must be a dedicated temporary directory.')
            require((root / '.portrait-platform-test-only').read_bytes() == b'no-network\n', 'Explicit test sentinel is required.')
            require(not isinstance(self.commands, Commands), 'Test mode forbids real subprocess commands.')
            for managed in (self.paths.app, self.paths.caddy, self.paths.unit, self.paths.enabled, *self.paths.system_roots):
                require(managed.is_relative_to(root), 'Test path escapes the temporary fixture.')
            self.root_uid = os.getuid()
            self.owner = pwd.getpwuid(os.getuid())
        else:
            require(self.paths == Paths() and isinstance(self.commands, Commands), 'Production paths and commands are fixed.')
            self.owner = pwd.getpwnam('ubuntu')

    def chown(self, path, uid, gid):
        os.chown(path, uid, gid, follow_symlinks=False)

    def private_directory(self, path, owner=None):
        info = no_links(path)
        require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and
                info.st_uid == (self.root_uid if owner is None else owner), 'Private deployment directory is unsafe.')

    def private_json(self, path):
        data, info = read_file(path, MAX_JSON, self.root_uid)
        require(stat.S_IMODE(info.st_mode) == 0o600, 'Deployment metadata must remain private.')
        value = strict_json(data)
        require(isinstance(value, dict), 'Deployment metadata is invalid.')
        return value

    def save_state(self, state):
        require(state['deploymentId'] and self.paths.state.parent.is_dir(), 'Owned state is missing.')
        data = encoded(state)
        if self.paths.state.exists():
            previous, info = read_file(self.paths.state, MAX_JSON, self.root_uid)
            require(stat.S_IMODE(info.st_mode) == 0o600, 'State permissions changed.')
            atomic_replace(self.paths.state, data, sha256(previous), 0o600, self.root_uid, info.st_gid)
        else:
            write_new(self.paths.state, data, 0o600)
        sync(self.paths.state.parent)

    def read_state(self, deployment_id):
        state = self.private_json(self.paths.state)
        require(ID.fullmatch(deployment_id or '') and state.get('schemaVersion') == 2 and
                state.get('deploymentId') == deployment_id and state.get('app') == str(self.paths.app) and
                state.get('service') == SERVICE and state.get('caddy') == str(self.paths.caddy), 'Deployment identity does not match the fixed installation.')
        for key in ('binarySha256', 'unitSha256', 'manifestSha256', 'archiveSha256', 'caddyBeforeSha256', 'caddyAfterSha256'):
            require(HASH.fullmatch(str(state.get(key, ''))), 'Deployment state public hash is invalid.')
        require(state['unitSha256'] == sha256(EXPECTED_UNIT), 'State service template changed.')
        app = no_links(self.paths.app)
        require(stat.S_ISDIR(app.st_mode) and app.st_uid == self.root_uid and
                (app.st_dev, app.st_ino) == (state['appDev'], state['appIno']), 'Owned app directory was replaced.')
        binary, info = read_file(self.paths.app / 'bin/portrait-server', MAX_BINARY, self.root_uid)
        require(stat.S_IMODE(info.st_mode) == 0o750 and sha256(binary) == state['binarySha256'], 'Owned immutable binary changed.')
        self.private_directory(self.paths.app / 'evidence')
        for name, digest in (('Caddyfile.before', state['caddyBeforeSha256']), ('Caddyfile.after', state['caddyAfterSha256'])):
            data, info = read_file(self.paths.app / 'evidence' / name, MAX_JSON, self.root_uid)
            require(stat.S_IMODE(info.st_mode) == 0o600 and sha256(data) == digest, 'Private Caddy backup changed.')
        return state

    def absent_installation(self):
        p = self.paths
        require(all(not os.path.lexists(path) for path in (p.app, p.unit, p.enabled)), 'An existing application or service requires manual review; nothing will be overwritten.')
        self.service_absent()
        no_links(p.app.parent)
        no_links(p.unit.parent)

    def service_absent(self):
        require(all(not os.path.lexists(root / (SERVICE + '.d')) for root in self.paths.system_roots), 'Existing service drop-ins require manual review.')
        require(self.commands.run(['/usr/bin/systemctl', 'show', '--property=LoadState', '--value', SERVICE], 'service preflight').strip() == b'not-found', 'The service name already exists.')
        require(not self.commands.run(['/usr/bin/ss', '-H', '-ltn', 'sport = :4137'], 'port preflight').strip(), 'Loopback port 4137 is already in use.')

    def staged(self, stage, pins):
        self.private_directory(stage, self.owner.pw_uid)
        require(set(p.name for p in stage.iterdir()) == {'portrait-server', 'portrait-studio.service', 'library.tar.gz', 'library.manifest.json'}, 'Staging files differ from the reviewed bundle.')
        for key in ('binarySha256', 'unitSha256', 'manifestSha256', 'archiveSha256'):
            require(HASH.fullmatch(str(pins.get(key, ''))), 'Reviewed payload hash is invalid.')
        collected = {}
        for name, key, maximum in (('portrait-server', 'binarySha256', MAX_BINARY), ('portrait-studio.service', 'unitSha256', MAX_JSON), ('library.manifest.json', 'manifestSha256', MAX_JSON)):
            data, info = read_file(stage / name, maximum, self.owner.pw_uid)
            require(stat.S_IMODE(info.st_mode) & 0o022 == 0 and sha256(data) == pins[key], 'Staging bytes or permissions changed.')
            collected[name] = data
        require(collected['portrait-studio.service'] == EXPECTED_UNIT, 'Service differs from the fixed platform template.')
        check_static_elf(collected['portrait-server'])
        manifest = strict_json(collected['library.manifest.json'])
        require(isinstance(manifest, dict) and manifest.get('archiveSha256') == pins['archiveSha256'], 'Archive binding changed.')
        info = no_links(stage / 'library.tar.gz')
        require(info.st_uid == self.owner.pw_uid and stat.S_IMODE(info.st_mode) & 0o022 == 0, 'Staged archive permissions are unsafe.')
        collected['index'] = inspect_archive(stage / 'library.tar.gz', manifest)
        collected['manifest'] = manifest
        return collected

    def adapt(self, path):
        self.commands.run(['/usr/bin/caddy', 'validate', '--config', str(path), '--adapter', 'caddyfile'], 'Caddy validation')
        value = strict_json(self.commands.run(['/usr/bin/caddy', 'adapt', '--config', str(path), '--adapter', 'caddyfile'], 'private Caddy adaptation'))
        require(isinstance(value, dict), 'Caddy adaptation is invalid.')
        return value

    def plan(self, stage, plan_dir, deployment_id, pins):
        self.absent_installation()
        self.staged(stage, pins)
        original, info = read_file(self.paths.caddy, MAX_JSON, self.root_uid)
        require(stat.S_IMODE(info.st_mode) & 0o022 == 0, 'Caddy configuration is writable by other users.')
        try:
            candidate = build_candidate(original)
        except ReviewError as exc:
            raise DeploymentError('Existing Caddy configuration requires private manual review.') from exc
        plan_dir.mkdir(mode=0o700)
        write_new(plan_dir / 'Caddyfile.before', original, 0o600)
        write_new(plan_dir / 'Caddyfile.candidate', candidate.candidate, 0o600)
        before = self.adapt(plan_dir / 'Caddyfile.before')
        after = self.adapt(plan_dir / 'Caddyfile.candidate')
        try:
            prove_adapted_unchanged(before, after)
        except ReviewError as exc:
            raise DeploymentError('Existing effective Caddy routes cannot be proven unchanged; no installation was prepared.') from exc
        current, _ = read_file(self.paths.caddy, MAX_JSON, self.root_uid)
        require(sha256(current) == candidate.original_sha256, 'Caddy changed while preparing the review plan.')
        state = {'schemaVersion': 2, 'deploymentId': deployment_id, 'status': 'reviewed', 'app': str(self.paths.app),
            'service': SERVICE, 'caddy': str(self.paths.caddy), 'stage': str(stage), 'plan': str(plan_dir),
            'caddyBeforeSha256': candidate.original_sha256, 'caddyAfterSha256': candidate.candidate_sha256,
            'caddyMode': stat.S_IMODE(info.st_mode), 'caddyUid': info.st_uid, 'caddyGid': info.st_gid,
            **pins, 'unitInstalled': False, 'serviceStarted': False, 'caddyInstalled': False,
            'count': 100, 'revision': 3, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        write_new(plan_dir / 'plan.json', encoded(state), 0o600)
        sync(plan_dir)
        return {'status': 'review-required', 'deploymentId': deployment_id, 'candidatePath': str(plan_dir / 'Caddyfile.candidate'),
            'beforeSha256': candidate.original_sha256, 'candidateSha256': candidate.candidate_sha256,
            'publicBlock': candidate.public_block, 'endpoint': PUBLIC, 'existingRoutesUnchanged': True, 'platformPasswordInitialized': False}

    def prepare(self, plan_dir, deployment_id, approval):
        self.private_directory(plan_dir)
        state = self.private_json(plan_dir / 'plan.json')
        require(state.get('deploymentId') == deployment_id and state.get('plan') == str(plan_dir) and
                HASH.fullmatch(approval or '') and state.get('caddyAfterSha256') == approval and state.get('status') == 'reviewed', 'Approval does not match the private reviewed plan.')
        stage = Path(state['stage'])
        self.absent_installation()
        material = self.staged(stage, state)
        original, info = read_file(self.paths.caddy, MAX_JSON, self.root_uid)
        require(sha256(original) == state['caddyBeforeSha256'] and stat.S_IMODE(info.st_mode) == state['caddyMode'] and info.st_gid == state['caddyGid'], 'Caddy changed after personal review.')
        before, _ = read_file(plan_dir / 'Caddyfile.before', MAX_JSON, self.root_uid)
        after, _ = read_file(plan_dir / 'Caddyfile.candidate', MAX_JSON, self.root_uid)
        require(sha256(before) == state['caddyBeforeSha256'] and sha256(after) == approval, 'Private reviewed candidate changed.')
        app = self.paths.app
        app.mkdir(mode=0o750)
        self.chown(app, self.root_uid, self.owner.pw_gid)
        os.chmod(app, 0o750)
        for directory in ('bin', 'data', 'config', 'evidence'):
            (app / directory).mkdir(mode=0o700)
        self.chown(app / 'bin', self.root_uid, self.owner.pw_gid)
        os.chmod(app / 'bin', 0o750)
        app_info = no_links(app)
        state.update(status='preparing', appDev=app_info.st_dev, appIno=app_info.st_ino)
        write_new(app / 'evidence/Caddyfile.before', before, 0o600)
        write_new(app / 'evidence/Caddyfile.after', after, 0o600)
        write_new(app / 'bin/portrait-server', material['portrait-server'], 0o750)
        self.chown(app / 'bin/portrait-server', self.root_uid, self.owner.pw_gid)
        self.save_state(state)
        extracted = inspect_archive(stage / 'library.tar.gz', material['manifest'], app / 'data')
        require(extracted == material['index'], 'Archive changed during extraction.')
        for directory, folders, files in os.walk(app / 'data', followlinks=False):
            for name in folders + files:
                path = Path(directory) / name
                no_links(path)
                self.chown(path, self.owner.pw_uid, self.owner.pw_gid)
        self.chown(app / 'data', self.owner.pw_uid, self.owner.pw_gid)
        self.chown(app / 'config', self.owner.pw_uid, self.owner.pw_gid)
        write_new(app / 'evidence/library.manifest.json', material['library.manifest.json'], 0o600)
        state['status'] = 'awaiting-admin-initialization'
        self.save_state(state)
        return {'status': state['status'], 'deploymentId': deployment_id, 'state': str(self.paths.state), 'endpoint': PUBLIC,
                'count': 100, 'revision': 3, 'serviceStarted': False, 'caddyInstalled': False}

    def admin_file(self):
        self.private_directory(self.paths.app / 'config', self.owner.pw_uid)
        info = no_links(self.paths.app / 'config/admin-auth.json')
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == self.owner.pw_uid and
                stat.S_IMODE(info.st_mode) == 0o600 and 1 <= info.st_size <= 16384,
                'Private admin initialization is missing or unsafe; service remains unexposed.')
        # Deliberately never open/read/hash/copy this private credential file.

    def effective_unit(self):
        raw = self.commands.run(['/usr/bin/systemctl', 'show', '--property=FragmentPath', '--property=User', '--property=Group', '--property=DropInPaths', '--property=ExecStart', '--property=Environment', SERVICE], 'effective owned service')
        values = {}
        try:
            for line in raw.decode().splitlines():
                name, value = line.split('=', 1)
                require(name not in values, 'Effective service property is duplicated.')
                values[name] = value
        except (UnicodeError, ValueError) as exc:
            raise DeploymentError('Effective service properties are invalid.') from exc
        require(values.get('FragmentPath') == str(self.paths.unit) and values.get('User') == 'ubuntu' and values.get('Group') == 'ubuntu' and values.get('DropInPaths') == '', 'Effective service identity or drop-ins changed.')
        # The exact immutable fragment, no drop-ins, and no persistent manager
        # override must also agree on the executable and the two public env values.
        expected_argv = str(self.paths.app / 'bin/portrait-server') + ' -listen 127.0.0.1:4137 -data ' + str(self.paths.app / 'data/photo_repo') + ' -version ' + RELEASE_VERSION
        executable = re.escape(str(self.paths.app / 'bin/portrait-server'))
        argv = re.escape(expected_argv)
        require(re.fullmatch(r'\{ path=' + executable + r' ; argv\[\]=' + argv + r' ; ignore_errors=no ; start_time=[^;{}]* ; stop_time=[^;{}]* ; pid=[0-9]+ ; code=[^;{}]* ; status=[^;{}]* \}', values.get('ExecStart', '')) and
                values.get('Environment') == 'PORTRAIT_STUDIO_ADMIN_USERNAME=admin PORTRAIT_STUDIO_AUTH_FILE=/home/ubuntu/portrait-studio/config/admin-auth.json', 'Effective service command or authentication environment changed.')

    def caddy_guard(self, state):
        current, info = read_file(self.paths.caddy, MAX_JSON, self.root_uid)
        require(sha256(current) in (state['caddyBeforeSha256'], state['caddyAfterSha256']) and
                stat.S_IMODE(info.st_mode) == state['caddyMode'] and info.st_uid == state['caddyUid'] and
                info.st_gid == state['caddyGid'], 'Caddy changed outside this installation; preserving operator changes.')
        return current

    def unit_guard(self, state):
        if os.path.lexists(self.paths.unit):
            data, info = read_file(self.paths.unit, MAX_JSON, self.root_uid)
            require(sha256(data) == state['unitSha256'] and stat.S_IMODE(info.st_mode) == 0o644, 'Owned service unit changed; preserving it.')
            require(all(not os.path.lexists(root / (SERVICE + '.d')) for root in self.paths.system_roots), 'Service gained an unreviewed drop-in.')
            if os.path.lexists(self.paths.enabled):
                enabled = self.paths.enabled.lstat()
                require(stat.S_ISLNK(enabled.st_mode) and enabled.st_uid == self.root_uid and
                        os.readlink(self.paths.enabled) == str(self.paths.unit), 'Service enablement changed outside this installation.')
            return True
        require(not os.path.lexists(self.paths.enabled), 'An unexpected enablement link requires review.')
        return False

    def activate(self, deployment_id, approval, verify=None):
        require(verify is None or self.test_mode, 'Injected HTTP checks require the explicit offline test runtime.')
        state = self.read_state(deployment_id)
        require(state['status'] == 'awaiting-admin-initialization' and approval == state['caddyAfterSha256'], 'Activation does not match the reviewed fresh installation.')
        self.admin_file()
        self.caddy_guard(state)
        require(not os.path.lexists(self.paths.unit) and not os.path.lexists(self.paths.enabled), 'A service appeared before activation.')
        self.service_absent()
        sidecar, _ = read_file(self.paths.app / 'evidence/library.manifest.json', MAX_JSON, self.root_uid)
        require(sha256(sidecar) == state['manifestSha256'], 'Pinned library sidecar changed.')
        manifest = strict_json(sidecar)
        inspect_tree(self.paths.app / 'data/photo_repo', manifest)
        try:
            write_new(self.paths.unit, EXPECTED_UNIT, 0o644)
            sync(self.paths.unit.parent)
            state['unitInstalled'] = True
            self.save_state(state)
            self.commands.run(['/usr/bin/systemctl', 'daemon-reload'], 'owned daemon reload')
            self.effective_unit()
            self.commands.run(['/usr/bin/systemctl', 'enable', SERVICE], 'owned enable')
            self.commands.run(['/usr/bin/systemctl', 'start', SERVICE], 'owned start')
            state['serviceStarted'] = True
            self.save_state(state)
            (verify or verify_http)(LOOPBACK, healthy_wait=True)
            # Starting Go must not mutate any of the seed bytes during review.
            inspect_tree(self.paths.app / 'data/photo_repo', manifest, allow_runtime_lock=True, lock_owner=self.owner.pw_uid)
            after, _ = read_file(self.paths.app / 'evidence/Caddyfile.after', MAX_JSON, self.root_uid)
            self.caddy_guard(state)
            self.adapt(self.paths.app / 'evidence/Caddyfile.after')
            atomic_replace(self.paths.caddy, after, state['caddyBeforeSha256'], state['caddyMode'], state['caddyUid'], state['caddyGid'])
            state['caddyInstalled'] = True
            self.save_state(state)
            self.commands.run(['/usr/bin/systemctl', 'reload', 'caddy.service'], 'Caddy activation reload')
            (verify or verify_http)(PUBLIC)
            state.update(status='active', verifiedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
            self.save_state(state)
            return {'status': 'active', 'deploymentId': deployment_id, 'state': str(self.paths.state), 'endpoint': PUBLIC,
                    'count': 100, 'revision': 3, 'initialized': True, 'unsignedBusinessStatus': 401,
                    'existingCaddyAuthenticationUnchanged': True, 'stateSha256': sha256(encoded(state))}
        except Exception as exc:
            state['status'] = 'activation-failed'
            self.save_state(state)
            try:
                self.rollback(deployment_id, internal=True)
            except Exception:
                state['status'] = 'rollback-partial'
                self.save_state(state)
                raise DeploymentError('Activation failed; guarded rollback is incomplete. Retained data and private state require operator review.') from exc
            raise DeploymentError('Activation failed; owned routes/service were rolled back. All library bytes and private admin configuration were retained.') from exc

    def rollback_plan(self, deployment_id):
        state = self.read_state(deployment_id)
        current = self.caddy_guard(state)
        unit_present = self.unit_guard(state)
        return {'status': 'rollback-review-required', 'deploymentId': deployment_id, 'state': str(self.paths.state),
                'rollbackApprovalSha256': sha256(encoded(state)), 'currentCaddySha256': sha256(current),
                'unitPresent': unit_present, 'dataRetained': True, 'privateAdminConfigurationRetained': True}

    def rollback(self, deployment_id, approval=None, internal=False):
        state = self.read_state(deployment_id)
        require(internal or approval == sha256(encoded(state)), 'Rollback approval does not match the current private state.')
        current = self.caddy_guard(state)
        present = self.unit_guard(state)
        before, _ = read_file(self.paths.app / 'evidence/Caddyfile.before', MAX_JSON, self.root_uid)
        self.adapt(self.paths.app / 'evidence/Caddyfile.before')
        if sha256(current) == state['caddyAfterSha256']:
            atomic_replace(self.paths.caddy, before, state['caddyAfterSha256'], state['caddyMode'], state['caddyUid'], state['caddyGid'])
        state.update(status='rollback-partial', caddyInstalled=False)
        self.save_state(state)
        require(sha256(self.caddy_guard(state)) == state['caddyBeforeSha256'], 'Caddy changed before rollback reload.')
        self.commands.run(['/usr/bin/systemctl', 'reload', 'caddy.service'], 'rollback Caddy reload')
        if present:
            self.unit_guard(state)
            self.commands.run(['/usr/bin/systemctl', 'stop', SERVICE], 'rollback owned stop')
            self.unit_guard(state)
            self.commands.run(['/usr/bin/systemctl', 'disable', SERVICE], 'rollback owned disable')
            self.unit_guard(state)
            self.paths.unit.unlink()
            sync(self.paths.unit.parent)
        state.update(unitInstalled=False, serviceStarted=False)
        self.save_state(state)
        self.commands.run(['/usr/bin/systemctl', 'daemon-reload'], 'rollback daemon reload')
        state.update(status='rolled-back', rolledBackAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        self.save_state(state)
        return {'status': 'rolled-back', 'deploymentId': deployment_id, 'dataRetained': True,
                'privateAdminConfigurationRetained': True, 'state': str(self.paths.state)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def fetch(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_JSON + 1)
        require(len(body) <= MAX_JSON, 'Public verification response is too large.')
        return response.code, response.headers, strict_json(body)


def verify_http(base, healthy_wait=False):
    require(base in (LOOPBACK, PUBLIC), 'Verification endpoint is fixed.')
    for attempt in range(20 if healthy_wait else 1):
        try:
            status, _, health = fetch(base + 'healthz')
            require(status == 200 and health.get('ok') is True and health.get('data', {}).get('status') == 'ok' and health.get('data', {}).get('version') == RELEASE_VERSION, 'Go health check failed.')
            break
        except (OSError, urllib.error.URLError):
            require(healthy_wait and attempt < 19, 'Go API did not become healthy using standard transport verification.')
            time.sleep(0.5)
    status, _, auth = fetch(base + 'v1/auth/status')
    require(status == 200 and auth.get('ok') is True and auth.get('data') == {'initialized': True, 'authenticated': False}, 'Fixed admin authentication is not initialized or its public contract differs.')
    for suffix in ('v1/library', 'v1/portraits/1', 'v1/images/1?revision=1'):
        status, headers, response = fetch(base + suffix)
        require(status == 401 and headers.get('WWW-Authenticate', '').startswith('Bearer ') and
                response.get('ok') is False and response.get('error', {}).get('code') == 'AUTH_REQUIRED', 'Unsigned business route is not protected by fixed admin Bearer authentication.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', required=True, choices=('plan', 'prepare', 'activate', 'rollback-plan', 'rollback'))
    parser.add_argument('--deployment-id', required=True)
    parser.add_argument('--staging')
    parser.add_argument('--plan')
    parser.add_argument('--pins')
    parser.add_argument('--approval')
    args = parser.parse_args(argv)
    require(sys.platform.startswith('linux') and platform.machine() == 'x86_64' and os.geteuid() == 0, 'Only root on the intended Ubuntu x86_64 server may run remote phases.')
    release, _ = read_file(Path('/usr/lib/os-release'), 16384, 0)
    require(re.search(rb'^ID=ubuntu$', release, re.M) and re.search(rb'^VERSION_ID="?24\.04"?$', release, re.M), 'Intended server OS is Ubuntu 24.04.')
    require(ID.fullmatch(args.deployment_id), 'Deployment identity is invalid.')
    os.umask(0o077)
    runtime = Runtime()
    if args.phase == 'plan':
        require(STAGING.fullmatch(args.staging or '') and PLAN.fullmatch(args.plan or '') and args.approval is None, 'Plan paths must be generated fixed private paths.')
        pins = strict_json((args.pins or '').encode())
        require(isinstance(pins, dict) and set(pins) == {'binarySha256', 'unitSha256', 'manifestSha256', 'archiveSha256'}, 'Public deployment pins are invalid.')
        result = runtime.plan(Path(args.staging), Path(args.plan), args.deployment_id, pins)
    elif args.phase == 'prepare':
        require(PLAN.fullmatch(args.plan or '') and args.staging is None and args.pins is None, 'Prepare only accepts a reviewed private plan.')
        result = runtime.prepare(Path(args.plan), args.deployment_id, args.approval)
    elif args.phase == 'activate':
        require(all(value is None for value in (args.plan, args.staging, args.pins)), 'Activation only accepts the fixed owned state.')
        result = runtime.activate(args.deployment_id, args.approval)
    else:
        require(all(value is None for value in (args.plan, args.staging, args.pins)) and (args.phase != 'rollback-plan' or args.approval is None), 'Rollback accepts only the fixed owned state.')
        result = runtime.rollback_plan(args.deployment_id) if args.phase == 'rollback-plan' else runtime.rollback(args.deployment_id, args.approval)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not echo exceptions: external tool/config output can contain secrets.
        print('Remote phase stopped safely. Retained private state requires operator review; no credentials were printed.', file=sys.stderr)
        sys.exit(1)
