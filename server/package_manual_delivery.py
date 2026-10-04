#!/usr/bin/env python3
"""Build a new reviewable platform-admin tools ZIP; never deploy or copy secrets."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'Portrait-Studio-Platform-Admin-Deployment-20261004-r1'
DEFAULT_RELEASE = ROOT / 'server/dist/Portrait-Studio-Server-platform-auth-20261004-r1'
DEFAULT_OUTPUT = ROOT / ('server/dist/' + NAME + '.zip')
DATA = ROOT / 'server/dist/Portrait-Studio-Library-100-r3.tar.gz'
DATA_SHA = '390cc75dde3c6f44aad0e12ff6a840423ff1199fb9be6867c7b3678e5d2d0799'
SIDECAR_SHA = '752120a072a348add59ff06024649dcc841375a4e7b018b8c3e6a4fcf3630f76'


def read_regular(path: Path) -> bytes:
    path = path.absolute()
    if '..' in path.parts:
        raise ValueError('Parent-directory traversal is forbidden in delivery paths')
    path.relative_to(ROOT)
    current = ROOT
    for part in path.relative_to(ROOT).parts:
        current /= part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError('Delivery path contains a symbolic link: ' + str(path.relative_to(ROOT)))
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 64 << 20:
        raise ValueError('Delivery member is not a bounded regular file: ' + path.name)
    content = path.read_bytes()
    latest = path.lstat()
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
            latest.st_dev, latest.st_ino, latest.st_size, latest.st_mtime_ns, latest.st_ctime_ns):
        raise ValueError('Delivery member changed while reading: ' + path.name)
    return content


def file_digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''):
            result.update(block)
    return result.hexdigest()


def build(release: Path, output: Path, evidence: list[Path]) -> dict:
    release = release.absolute()
    if '..' in release.parts:
        raise ValueError('Parent-directory traversal is forbidden in release paths')
    release.relative_to(ROOT / 'server/dist')
    output = output.absolute()
    if '..' in output.parts:
        raise ValueError('Parent-directory traversal is forbidden in output paths')
    output.relative_to(ROOT / 'server/dist')
    for ancestor in (output.parent, *output.parent.parents):
        if ancestor == ROOT:
            break
        if ancestor.exists() and ancestor.is_symlink():
            raise ValueError('Output ancestors must not be symbolic links')
    if output.exists() or Path(str(output) + '.manifest.json').exists():
        raise ValueError('Delivery already exists; historical artifacts must not be overwritten')
    if file_digest(DATA) != DATA_SHA or file_digest(Path(str(DATA) + '.manifest.json')) != SIDECAR_SHA:
        raise ValueError('The reusable 100-record archive or sidecar changed')
    paths = {
        ROOT / 'README.md', ROOT / 'server/README.md', ROOT / 'server/.env.example',
        ROOT / 'server/build_release.py', ROOT / 'server/RELEASE-BUILD.md',
        ROOT / 'server/package_manual_delivery.py', ROOT / 'server/deploy/USER-DEPLOY.md',
        ROOT / 'server/deploy/caddy-platform-auth.example',
        Path(str(DATA) + '.manifest.json'),
    }
    deployment = ROOT / 'server/deploy/platform_admin'
    for pattern in ('*.py', '*.service', 'manifest.json'):
        paths.update(deployment.glob(pattern))
    for required in ('deploy_from_mac.py', 'deploy_server.py', 'archive_validation.py',
                     'caddy_review.py', 'portrait-studio.service', 'manifest.json'):
        if deployment / required not in paths:
            raise ValueError('Missing current deployment member: ' + required)
    paths.update(path for path in release.rglob('*') if path.is_file() or path.is_symlink())
    if not (release / 'release-manifest.json').is_file():
        raise ValueError('The current fixed-admin Go release manifest is missing')
    paths.update(path.absolute() for path in evidence)
    members = []
    content = {}
    for path in sorted(paths):
        relative = path.relative_to(ROOT).as_posix()
        # Only the explicit public example may be an environment file.
        if ('admin-auth' in path.name or path.name == '.env' or
                path.name.startswith('.env.') and path.name != '.env.example'):
            raise ValueError('Private credential path is forbidden in a delivery')
        raw = read_regular(path)
        content[relative] = raw
        members.append({'path': relative, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    manifest = {
        'schemaVersion': 1, 'name': NAME, 'purpose': 'user-reviewed fixed-admin server deployment',
        'productionDeployed': False, 'productionPasswordInitialized': False,
        'newMacPackage': False, 'secretsIncluded': False, 'files': members,
        'reusableLibrary': {
            'path': DATA.relative_to(ROOT).as_posix(), 'archiveIncluded': False,
            'archiveSize': DATA.stat().st_size, 'archiveSha256': DATA_SHA,
            'sidecarIncluded': True, 'sidecarSha256': SIDECAR_SHA, 'count': 100, 'revision': 3,
        },
        'entry': 'python3 server/deploy/platform_admin/deploy_from_mac.py',
        'defaultRemoteActions': 0,
    }
    content['DELIVERY-MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    content['START-HERE.txt'] = (
        'Portrait Studio platform admin delivery; NOT DEPLOYED.\n'
        'Read server/deploy/USER-DEPLOY.md and the Python scripts before running.\n'
        'Copy the unchanged 100-r3 archive into server/dist/ (its sidecar is included).\n'
        'Default: python3 server/deploy/platform_admin/deploy_from_mac.py --prepare\n'
        'Only the operator may run --apply in a real terminal and privately initialize admin.\n'
        'No password, token, production Caddy config, or Mac installer is included.\n'
    ).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='portrait-tools-zip-', dir='/tmp') as temporary:
        staged = Path(temporary) / output.name
        with zipfile.ZipFile(staged, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for relative, raw in sorted(content.items()):
                member = zipfile.ZipInfo(NAME + '/' + relative, date_time=(2026, 10, 4, 0, 0, 0))
                member.compress_type = zipfile.ZIP_DEFLATED
                member.create_system = 3
                mode = 0o755 if relative.endswith('/bin/portrait-server') else 0o644
                member.external_attr = (stat.S_IFREG | mode) << 16
                archive.writestr(member, raw)
        with zipfile.ZipFile(staged) as archive:
            if archive.testzip() is not None:
                raise ValueError('ZIP integrity check failed')
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(descriptor, 'wb') as target, staged.open('rb') as source:
            for block in iter(lambda: source.read(1 << 20), b''):
                target.write(block)
            target.flush()
            os.fsync(target.fileno())
    result = {**manifest, 'archive': str(output), 'archiveSize': output.stat().st_size,
              'archiveSha256': file_digest(output)}
    sidecar = Path(str(output) + '.manifest.json')
    descriptor = os.open(sidecar, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(descriptor, 'w') as target:
        json.dump(result, target, ensure_ascii=False, indent=2)
        target.write('\n')
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir', type=Path, default=DEFAULT_RELEASE)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--evidence', type=Path, action='append', default=[])
    args = parser.parse_args()
    try:
        result = build(args.release_dir, args.output, args.evidence)
        print(json.dumps({'archive': result['archive'], 'bytes': result['archiveSize'],
                          'sha256': result['archiveSha256'], 'files': len(result['files']),
                          'productionDeployed': False, 'libraryArchiveIncluded': False}, indent=2))
        return 0
    except (OSError, ValueError) as error:
        print('Delivery packaging stopped: ' + str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
