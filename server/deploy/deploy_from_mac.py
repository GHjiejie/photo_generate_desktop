#!/usr/bin/env python3
"""User-run deployment wrapper. Default mode checks local files only.

No remote action happens without an explicit --apply or --rollback flag.
SSH uses the user's existing agent/configuration and verified known_hosts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import uuid

TARGET = 'ubuntu@18.180.65.241'
STATE = '/home/ubuntu/portrait-studio/evidence/deployment-state.json'
PUBLIC_URL = 'https://dashboard-18-180-65-241.sslip.io/portrait-studio/'
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARCHIVE = ROOT / 'server/dist/Portrait-Studio-Library-100-r3.tar.gz'
RECEIPT = ROOT / 'server/dist/portrait-studio-user-deployment-receipt.json'
HASH = re.compile(r'^[0-9a-f]{64}$')
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no',
               '-o', 'ConnectTimeout=10']


class DeliveryError(Exception):
    pass


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DeliveryError('Duplicate JSON key in delivery metadata')
        result[key] = value
    return result


def regular_file(path, maximum):
    path = Path(path).absolute()
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise DeliveryError('Payload paths must not contain symbolic links')
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise DeliveryError('Payload ancestor is not a directory')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= maximum:
        raise DeliveryError('Payload is not a bounded regular file: ' + path.name)
    return path


def fingerprint(path, maximum):
    path = regular_file(path, maximum)
    info = path.lstat()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    digest = hashlib.sha256()
    with os.fdopen(descriptor, 'rb') as source:
        opened = os.fstat(source.fileno())
        if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
            raise DeliveryError('Payload changed while opening')
        for chunk in iter(lambda: source.read(1 << 20), b''):
            digest.update(chunk)
        after = os.fstat(source.fileno())
    latest = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
    if any(getattr(info, field) != getattr(after, field) or
           getattr(info, field) != getattr(latest, field) for field in fields):
        raise DeliveryError('Payload changed while hashing')
    return {'path': path, 'size': info.st_size, 'sha256': digest.hexdigest()}


def read_json(path):
    path = regular_file(path, 32 << 20)
    with path.open('rb') as source:
        result = json.loads(source.read().decode('utf-8'), object_pairs_hook=strict_object)
    if not isinstance(result, dict):
        raise DeliveryError('Delivery metadata must be a JSON object')
    return result


def verify_tools():
    manifest = read_json(ROOT / 'server/deploy/manual-deployment-manifest.json')
    expected = {
        'server/deploy/deploy_server.py': 1 << 20,
        'server/deploy/portrait-studio.service': 1 << 20,
        'server/dist/portrait-server-linux-amd64': 64 << 20,
    }
    if manifest.get('schemaVersion') != 1 or manifest.get('target') != TARGET or \
            not isinstance(manifest.get('files'), dict):
        raise DeliveryError('Incorrect deployment-tool manifest')
    result = {}
    for relative, maximum in expected.items():
        entry = manifest.get('files', {}).get(relative, {})
        if not isinstance(entry, dict):
            raise DeliveryError('Incorrect deployment-tool entry')
        actual = fingerprint(ROOT / relative, maximum)
        if not HASH.fullmatch(str(entry.get('sha256', ''))) or any(
                actual[field] != entry.get(field) for field in ('sha256', 'size')):
            raise DeliveryError('Delivery integrity mismatch: ' + relative)
        result[relative] = actual
    return result


def verify_payload(archive):
    result = verify_tools()
    archive_info = fingerprint(archive, 1 << 30)
    sidecar = fingerprint(str(archive_info['path']) + '.manifest.json', 32 << 20)
    manifest = read_json(sidecar['path'])
    tools_manifest = read_json(ROOT / 'server/deploy/manual-deployment-manifest.json')
    pinned_data = tools_manifest.get('library', {})
    if not isinstance(pinned_data, dict):
        raise DeliveryError('Incorrect library delivery metadata')
    if manifest.get('archiveSha256') != archive_info['sha256']:
        raise DeliveryError('Library archive hash does not match its manifest')
    if manifest.get('count') != 100 or manifest.get('revision') != 3:
        raise DeliveryError('Expected exactly 100 records at revision 3')
    if pinned_data.get('archiveSha256') != archive_info['sha256'] or \
            pinned_data.get('manifestSha256') != sidecar['sha256']:
        raise DeliveryError('Library payload does not match the reviewed delivery')
    result['archive'] = archive_info
    result['sidecar'] = sidecar
    return result


def remote_command(arguments, script=None, capture=False):
    # Only fixed target/commands and generated staging paths enter this command.
    command = ['ssh', *SSH_OPTIONS, TARGET, shlex.join(arguments)]
    return subprocess.run(command, input=script, check=True,
                          stdout=subprocess.PIPE if capture else None)


def server_script(tools):
    entry = tools['server/deploy/deploy_server.py']
    raw = entry['path'].read_bytes()
    if hashlib.sha256(raw).hexdigest() != entry['sha256']:
        raise DeliveryError('Deployment script changed after verification')
    return raw


def apply(archive):
    payload = verify_payload(archive)
    script = server_script(payload)
    regular_file(RECEIPT.parent / 'portrait-server-linux-amd64', 64 << 20)
    if os.path.lexists(RECEIPT):
        raise DeliveryError('An existing deployment receipt requires review before a new deployment')
    staging = '/tmp/portrait-studio-stage-' + uuid.uuid4().hex
    print('User-requested deployment: dedicated Go service, 100 portraits and protected HTTPS prefix.', flush=True)
    remote_command(['sh', '-c', 'umask 077; mkdir -- ' + shlex.quote(staging)])
    staged_files = {
        'portrait-server': payload['server/dist/portrait-server-linux-amd64'],
        'portrait-studio.service': payload['server/deploy/portrait-studio.service'],
        'photo-repo-100.tar.gz': payload['archive'],
        'photo-repo-100.tar.gz.manifest.json': payload['sidecar'],
    }
    for name, entry in staged_files.items():
        subprocess.run(['scp', *SSH_OPTIONS, str(entry['path']), TARGET + ':' + staging + '/' + name], check=True)
    # Root receives reviewed code over stdin, never executes a mutable staged script.
    remote_command(['sudo', '-n', 'python3', '-', '--apply', '--staging', staging,
                    '--binary-sha256', payload['server/dist/portrait-server-linux-amd64']['sha256'],
                    '--unit-sha256', payload['server/deploy/portrait-studio.service']['sha256'],
                    '--manifest-sha256', payload['sidecar']['sha256']], script=script)
    receipt = {'schemaVersion': 1, 'target': TARGET, 'staging': staging,
               'state': STATE, 'publicURL': PUBLIC_URL,
               'status': 'server-script-returned-success',
               'rollback': 'python3 server/deploy/deploy_from_mac.py --rollback'}
    descriptor = os.open(RECEIPT, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(receipt, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print('Deployment receipt: ' + str(RECEIPT))


def rollback():
    tools = verify_tools()
    print('User-requested guarded rollback; the newly deployed library will be retained.', flush=True)
    remote_command(['sudo', '-n', 'python3', '-', '--rollback', '--state', STATE],
                   script=server_script(tools))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--prepare', action='store_true', help='Verify local payload only (default)')
    mode.add_argument('--apply', action='store_true', help='User explicitly requests server deployment')
    mode.add_argument('--rollback', action='store_true', help='User explicitly requests guarded server rollback')
    parser.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    arguments = parser.parse_args()
    try:
        if arguments.apply:
            apply(arguments.archive)
        elif arguments.rollback:
            rollback()
        else:
            payload = verify_payload(arguments.archive)
            print(json.dumps({'status': 'local-payload-verified', 'remoteActions': 0,
                              'records': 100, 'revision': 3, 'target': TARGET,
                              'archive': str(payload['archive']['path']),
                              'archiveSha256': payload['archive']['sha256']}, indent=2))
        return 0
    except (DeliveryError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print('Deployment stopped: ' + str(error), file=sys.stderr)
        print('No credentials are requested or stored. Review the private server state before retrying.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
