#!/usr/bin/env python3
"""Build/verify the fixed-admin Go component locally, without network/deployment.

Only explicitly listed sources and examples enter the release. Existing output
paths are never replaced. The 100-record gallery remains a separate pinned file.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parent
DEFAULT_VERSION = 'platform-auth-20261004-r1'
GO_VERSION = 'go1.26.4'
LIBRARY_NAME = 'Portrait-Studio-Library-100-r3.tar.gz'
LIBRARY_SHA = '390cc75dde3c6f44aad0e12ff6a840423ff1199fb9be6867c7b3678e5d2d0799'
LIBRARY_SIZE = 227072304
LIBRARY_MANIFEST_SHA = '752120a072a348add59ff06024649dcc841375a4e7b018b8c3e6a4fcf3630f76'
GO_FLAGS = ['-trimpath', '-buildvcs=false', '-ldflags=-s -w']
SAFE_INPUTS = (
    'go.mod', 'go.sum', 'README.md', '.env.example', 'build_release.py',
    'RELEASE-BUILD.md', 'test_build_release.py',
    'deploy/portrait-studio-platform-auth.service',
    'deploy/caddy-platform-auth.example',
    'cmd/portrait-server/main.go', 'cmd/portrait-server/main_test.go',
    'internal/auth/auth.go', 'internal/auth/credential.go', 'internal/auth/auth_test.go',
    'internal/httpapi/api.go', 'internal/httpapi/json.go', 'internal/httpapi/upload.go',
    'internal/httpapi/api_test.go', 'internal/httpapi/auth_test.go',
    'internal/httpapi/native_auth_harness_test.go',
    'internal/store/store.go', 'internal/store/types.go', 'internal/store/files.go',
    'internal/store/transaction.go', 'internal/store/batch.go', 'internal/store/store_test.go',
)
AUTH_CONTRACT = {
    'username': 'admin', 'accountCount': 1, 'registration': False, 'userCRUD': False,
    'defaultPassword': False, 'passwordHash': {'algorithm': 'argon2id', 'version': 19,
        'memoryKiB': 19456, 'iterations': 2, 'parallelism': 1, 'saltBytes': 16,
        'hashBytes': 32, 'minimumPasswordCharacters': 12, 'maximumPasswordUTF8Bytes': 1024},
    'session': {'lifetimeSeconds': 28800, 'opaqueRandomBytes': 32,
        'encoding': 'unpadded-base64url', 'tokenCharacters': 43,
        'serverStorage': 'in-memory SHA-256 digests', 'maximumSessions': 8,
        'restartInvalidates': True, 'logoutRevokes': True},
    'loginLimits': {'attemptsPerMinute': 5, 'maximumConcurrentHashes': 1},
    'publicRoutes': ['GET /healthz', 'GET /v1/auth/status', 'POST /v1/auth/login'],
    'protectedRoutes': ['GET /v1/auth/session', 'DELETE /v1/auth/session',
        'GET /v1/library', 'GET /v1/portraits/{id}', 'GET /v1/images/{id}?revision=N',
        'POST /v1/portraits', 'PATCH /v1/portraits/{id}', 'DELETE /v1/portraits/{id}',
        'POST /v1/batches/preview', 'POST /v1/batches/{previewId}/commit',
        'DELETE /v1/batches/{previewId}'],
    'bearerRequiredBeforeLibraryBodyParsing': True,
    'uninitializedRejectsLibraryAccess': True,
    'responses': {
        'status': {'initialized': 'boolean', 'authenticated': False},
        'loginInput': {'username': 'admin', 'password': 'private user input'},
        'login': {'username': 'admin', 'sessionToken': 'opaque bearer secret', 'expiresAt': 'RFC3339'},
        'session': {'username': 'admin', 'expiresAt': 'RFC3339'},
        'logout': {'loggedOut': True},
    },
    'errors': {'401': ['AUTH_REQUIRED', 'SESSION_EXPIRED', 'AUTH_NOT_INITIALIZED',
        'INVALID_CREDENTIALS'], '429': ['AUTH_RATE_LIMITED'], '503': ['AUTH_UNAVAILABLE']},
    'initialization': {'usernameEnvironment': 'PORTRAIT_STUDIO_ADMIN_USERNAME',
        'credentialFileEnvironment': 'PORTRAIT_STUDIO_AUTH_FILE',
        'passwordHashEnvironment': 'PORTRAIT_STUDIO_ADMIN_PASSWORD_HASH',
        'credentialSourcesMutuallyExclusive': True, 'secretFileMode': '0600',
        'secretDirectoryMode': '0700', 'interactiveTTYOnly': True,
        'passwordConfirmation': True, 'plaintextPasswordEnvironment': False,
        'passwordArguments': False, 'pipedPasswords': False, 'overwrite': False},
}


class ReleaseError(Exception):
    pass


def fail(message: str) -> None:
    raise ReleaseError(message)


def fingerprint(path: Path, limit: int = 64 << 20) -> dict:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        fail('Release inputs must be bounded regular files, without links')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != \
                (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
            fail('A release input changed while it was being opened')
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(fd, 'rb', closefd=False) as source:
            while chunk := source.read(1 << 20):
                size += len(chunk)
                if size > limit:
                    fail('A release input grew beyond its permitted size')
                digest.update(chunk)
        after = path.lstat()
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != \
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or size != opened.st_size:
            fail('A release input changed while it was being read')
        return {'size': size, 'sha256': digest.hexdigest(),
                'mode': format(stat.S_IMODE(opened.st_mode), '04o')}
    finally:
        os.close(fd)


def exact_json(path: Path, limit: int = 1 << 20) -> dict:
    fingerprint(path, limit)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail('A release manifest contains duplicate keys')
            result[key] = value
        return result
    try:
        result = json.loads(path.read_bytes(), object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        fail('A release manifest is not valid JSON')
    if not isinstance(result, dict):
        fail('A release manifest must be an object')
    return result


def check_version(value: str) -> str:
    match = re.fullmatch(r'platform-auth-(\d{8})-r[1-9]\d*', value)
    if not match:
        fail('Use a version such as platform-auth-20261004-r1')
    try:
        dt.datetime.strptime(match.group(1), '%Y%m%d')
    except ValueError:
        fail('The release version has an invalid calendar date')
    return value


def secret_guard(data: bytes, name: str) -> None:
    # Actual PHC values and private keys must never enter the source release.
    if re.search(rb'\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]{8,}\$[A-Za-z0-9+/]{8,}', data) or \
            re.search(rb'-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----', data):
        fail('A source input appears to contain a real secret; release aborted')
    if name == '.env.example':
        for line in data.decode('utf-8').splitlines():
            if line.strip() and not line.lstrip().startswith('#'):
                key, _, value = line.partition('=')
                if key == 'PORTRAIT_STUDIO_ADMIN_USERNAME' and value == 'admin':
                    continue
                if key == 'PORTRAIT_STUDIO_AUTH_FILE' and value == '/home/ubuntu/portrait-studio/config/admin-auth.json':
                    continue
                fail('The environment example contains an unexpected active value')


def check_elf(path: Path) -> None:
    fingerprint(path)
    with path.open('rb') as source:
        header = source.read(64)
        if len(header) != 64:
            fail('The release binary is truncated')
        fields = struct.unpack('<16sHHIQQQIHHHHHH', header)
        if fields[0][:7] != b'\x7fELF\x02\x01\x01' or fields[1] != 2 or fields[2] != 62 or fields[9] != 56 or fields[10] > 64:
            fail('The release must contain a Linux/amd64 ELF executable')
        source.seek(fields[5])
        for _ in range(fields[10]):
            entry = source.read(56)
            if len(entry) != 56 or struct.unpack_from('<I', entry)[0] in (2, 3):
                fail('The Go release must be statically linked without an ELF interpreter')


def library_binding(archive: Path) -> dict:
    sidecar = Path(str(archive) + '.manifest.json')
    archive_info = fingerprint(archive, LIBRARY_SIZE)
    sidecar_info = fingerprint(sidecar, 1 << 20)
    if archive_info['sha256'] != LIBRARY_SHA or archive_info['size'] != LIBRARY_SIZE or sidecar_info['sha256'] != LIBRARY_MANIFEST_SHA:
        fail('The gallery is not the pinned, existing 100-record revision-3 archive')
    manifest = exact_json(sidecar)
    if manifest.get('schemaVersion') != 1 or manifest.get('count') != 100 or manifest.get('revision') != 3 or manifest.get('root') != 'photo_repo':
        fail('The gallery manifest does not describe the expected schema/count/revision')
    declared = manifest.get('files')
    if not isinstance(declared, list) or len(declared) != 108:
        fail('The gallery manifest has an unexpected file count')
    files = {entry['path']: entry for entry in declared}
    if len(files) != len(declared):
        fail('The gallery manifest contains duplicate files')
    seen = set()
    total = 0
    index = None
    with tarfile.open(archive, 'r|gz') as source:
        for member in source:
            parts = PurePosixPath(member.name).parts
            if not member.isfile() or not parts or parts[0] != 'photo_repo' or any(p in ('', '.', '..') for p in parts) or '\\' in member.name or member.name in seen or member.name not in files or member.size > 32 << 20:
                fail('The gallery archive contains an unsafe or unexpected member')
            seen.add(member.name)
            total += member.size
            if total > 256 << 20:
                fail('The gallery archive exceeds the expected bounds')
            stream = source.extractfile(member)
            if stream is None:
                fail('A gallery member is unreadable')
            digest = hashlib.sha256()
            chunks = [] if member.name == 'photo_repo/.portrait-studio/library.json' else None
            size = 0
            while chunk := stream.read(1 << 20):
                size += len(chunk)
                digest.update(chunk)
                if chunks is not None:
                    chunks.append(chunk)
            entry = files[member.name]
            if size != entry['size'] or digest.hexdigest() != entry['sha256']:
                fail('Gallery bytes differ from their pinned file manifest')
            if chunks is not None:
                index = json.loads(b''.join(chunks))
    if seen != set(files) or total != manifest['totalSize'] or index is None or index.get('schemaVersion') != 1 or index.get('revision') != 3 or len(index.get('items', [])) != 100:
        fail('The gallery archive has an unexpected index or total size')
    for item in index['items']:
        image = files.get('photo_repo/' + item.get('imageRel', ''))
        if not image or image['sha256'] != item.get('sha256') or image['size'] != item.get('size'):
            fail('A gallery record does not bind to its actual image bytes')
    return {'external': True, 'filename': LIBRARY_NAME, 'manifestFilename': LIBRARY_NAME + '.manifest.json',
            'root': 'photo_repo', 'count': 100, 'revision': 3, 'fileCount': len(files),
            'archiveSize': archive_info['size'], 'archiveSha256': archive_info['sha256'],
            'manifestSha256': sidecar_info['sha256'], 'indexSha256': files['photo_repo/.portrait-studio/library.json']['sha256'],
            'totalUncompressedSize': total, 'compatibility': 'schema-1 index and every image size/SHA verified; native Go data test is separate'}


def write_file(path: Path, data: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as out:
        out.write(data)
    path.chmod(mode)


def canonical_json(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')


def manifest_files(root: Path) -> dict:
    files = {}
    for path in sorted(root.rglob('*')):
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            fail('A release contains a link or non-regular entry')
        if stat.S_ISREG(mode):
            files[str(path.relative_to(root))] = fingerprint(path)
    return files


def assert_new_outputs(output: Path, archive: Path) -> None:
    for path in (output, archive, Path(str(archive) + '.sha256')):
        if path.exists() or path.is_symlink():
            fail('An output already exists; historical releases are never overwritten')


def deterministic_archive(root: Path, destination: Path) -> None:
    with destination.open('xb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=9) as zipped:
            with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                for path in sorted(root.rglob('*')):
                    if path.is_symlink():
                        fail('A release output became a symlink')
                    name = root.name + '/' + str(path.relative_to(root))
                    info = tarfile.TarInfo(name)
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    if path.is_dir():
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        archive.addfile(info)
                    else:
                        entry = fingerprint(path)
                        info.mode = int(entry['mode'], 8)
                        info.size = entry['size']
                        with path.open('rb') as source:
                            archive.addfile(info, source)


def verify_release(root: Path, archive: Path | None = None) -> dict:
    root = root.resolve(strict=True)
    manifest = exact_json(root / 'release-manifest.json', 4 << 20)
    check_version(manifest.get('releaseVersion', ''))
    if manifest.get('schemaVersion') != 1 or manifest.get('target') != {'os': 'linux', 'arch': 'amd64'} or manifest.get('auth') != AUTH_CONTRACT:
        fail('The release manifest does not match the fixed-admin Linux contract')
    files = manifest.get('files')
    if not isinstance(files, dict):
        fail('The release file manifest is missing')
    actual = manifest_files(root)
    expected_names = set(files) | {'release-manifest.json', 'SHA256SUMS'}
    if set(actual) != expected_names:
        fail('The release has missing or unexpected files')
    for name, expected in files.items():
        if str(PurePosixPath(name)) != name or name.startswith('/') or '..' in PurePosixPath(name).parts or '\\' in name or actual[name] != expected:
            fail('Release content differs from its SHA/size/mode manifest')
    check_elf(root / 'bin/portrait-server')
    binary = manifest.get('binary', {})
    if binary != {'path': 'bin/portrait-server', **actual['bin/portrait-server'], 'os': 'linux', 'arch': 'amd64', 'static': True}:
        fail('The release binary pin is invalid')
    if exact_json(root / 'auth-contract.json') != AUTH_CONTRACT:
        fail('The separate authentication contract is inconsistent')
    expected_sums = ''.join(f"{value['sha256']}  {name}\n" for name, value in sorted(actual.items()) if name != 'SHA256SUMS')
    if (root / 'SHA256SUMS').read_text() != expected_sums:
        fail('The release SHA256SUMS file is inconsistent')
    if archive is not None and manifest.get('library') != library_binding(archive):
        fail('The external gallery binding differs from this release')
    return {'releaseDirectory': str(root), 'releaseVersion': manifest['releaseVersion'],
            'manifest': fingerprint(root / 'release-manifest.json'), 'binary': binary,
            'filesVerified': len(files), 'libraryVerified': archive is not None,
            'deployed': False, 'productionCredentialsCreated': False}


def build_release(version: str, output_root: Path, module_cache: Path,
                  build_cache: Path, library: Path) -> dict:
    version = check_version(version)
    output_root = output_root.resolve(strict=True)
    name = 'Portrait-Studio-Server-' + version
    output = output_root / name
    archive = output_root / (name + '.tar.gz')
    assert_new_outputs(output, archive)
    module_cache = module_cache.resolve(strict=True)
    build_cache = build_cache.resolve(strict=True)
    if not module_cache.is_dir() or not build_cache.is_dir():
        fail('Existing offline module and build cache directories are required')
    binding = library_binding(library)
    go = shutil.which('go')
    if not go:
        fail('The local Go toolchain was not found')
    environment = {name: os.environ[name] for name in ('PATH', 'TMPDIR', 'LANG') if name in os.environ}
    environment.update({'GOENV': 'off', 'GOTOOLCHAIN': 'local', 'GOPROXY': 'off',
        'GOSUMDB': 'off', 'GONOSUMDB': '', 'GOPRIVATE': '', 'GOWORK': 'off',
        'GOFLAGS': '', 'GOEXPERIMENT': '', 'CGO_ENABLED': '0', 'GOOS': 'linux',
        'GOARCH': 'amd64', 'GOCACHE': str(build_cache), 'GOMODCACHE': str(module_cache)})
    current_version = subprocess.run([go, 'version'], env=environment, check=True, capture_output=True, text=True).stdout.split()
    if len(current_version) < 3 or current_version[2] != GO_VERSION:
        fail('Reproducible release builds require the pinned local Go toolchain ' + GO_VERSION)
    stage = Path(tempfile.mkdtemp(prefix='portrait-go-release-', dir=output_root))
    try:
        original = {}
        for relative in SAFE_INPUTS:
            path = ROOT / relative
            original[relative] = fingerprint(path, 8 << 20)
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != original[relative]['sha256']:
                fail('A source changed during the release snapshot')
            secret_guard(data, relative)
            write_file(stage / relative, data, 0o755 if relative == 'build_release.py' else 0o644)
        write_file(stage / 'data' / (LIBRARY_NAME + '.manifest.json'), Path(str(library) + '.manifest.json').read_bytes())
        write_file(stage / 'auth-contract.json', canonical_json(AUTH_CONTRACT))
        (stage / 'bin').mkdir()
        binary_path = stage / 'bin/portrait-server'
        subprocess.run([go, 'build', *GO_FLAGS, '-o', str(binary_path), './cmd/portrait-server'],
                       cwd=stage, env=environment, check=True, capture_output=True, text=True)
        binary_path.chmod(0o755)
        check_elf(binary_path)
        for relative, expected in original.items():
            if fingerprint(ROOT / relative, 8 << 20) != expected:
                fail('A source changed while the release was building; no final output was published')
        files = manifest_files(stage)
        manifest = {'schemaVersion': 1, 'releaseVersion': version,
            'component': 'Portrait Studio fixed-admin Go server', 'target': {'os': 'linux', 'arch': 'amd64'},
            'build': {'goVersion': GO_VERSION, 'flags': GO_FLAGS, 'cgoEnabled': False,
                'offline': True, 'archiveTimestamp': 0, 'modules': {'golang.org/x/crypto': 'v0.28.0',
                'golang.org/x/image': 'v0.32.0', 'golang.org/x/sys': 'v0.26.0', 'golang.org/x/term': 'v0.25.0'},
                'dependencyStatus': 'pinned existing official module cache; not claimed latest'},
            'binary': {'path': 'bin/portrait-server', **files['bin/portrait-server'], 'os': 'linux', 'arch': 'amd64', 'static': True},
            'auth': AUTH_CONTRACT, 'library': binding, 'files': files,
            'runtime': {'listen': '127.0.0.1:4137', 'versionFlag': version,
                'dataPath': '/home/ubuntu/portrait-studio/data/photo_repo',
                'credentialFile': '/home/ubuntu/portrait-studio/config/admin-auth.json',
                'dedicatedHTTPSHostPlan': 'portrait-18-180-65-241.sslip.io'},
            'status': {'deployed': False, 'remoteConnectionAttemptedByBuilder': False,
                'productionCredentialsIncluded': False, 'productionCredentialsInitialized': False,
                'existingDashboardBasicProtectionChanged': False,
                'requiresSeparateReviewedOperatorDeployment': True}}
        write_file(stage / 'release-manifest.json', canonical_json(manifest))
        sums = ''.join(f"{entry['sha256']}  {relative}\n" for relative, entry in sorted(manifest_files(stage).items()))
        write_file(stage / 'SHA256SUMS', sums.encode())
        verify_release(stage)
        assert_new_outputs(output, archive)
        output.mkdir(mode=0o700)  # exclusive reservation; never replace any directory
        for path in sorted(stage.rglob('*')):
            relative = path.relative_to(stage)
            if path.is_dir():
                (output / relative).mkdir(mode=0o755, exist_ok=True)
            else:
                write_file(output / relative, path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
        deterministic_archive(output, archive)
        archive_info = fingerprint(archive)
        write_file(Path(str(archive) + '.sha256'), (archive_info['sha256'] + '  ' + archive.name + '\n').encode())
        return {**verify_release(output), 'archive': {'path': str(archive), **archive_info},
            'archiveChecksumFile': str(Path(str(archive) + '.sha256')), 'library': binding}
    finally:
        shutil.rmtree(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    build = actions.add_parser('build', help='Build a new offline release; no server connection')
    build.add_argument('--version', default=DEFAULT_VERSION)
    build.add_argument('--output-root', type=Path, default=ROOT / 'dist')
    build.add_argument('--mod-cache', type=Path, required=True)
    build.add_argument('--build-cache', type=Path, required=True)
    build.add_argument('--library-archive', type=Path, default=ROOT / 'dist' / LIBRARY_NAME)
    verify = actions.add_parser('verify', help='Read-only verification of an extracted release')
    verify.add_argument('release_directory', type=Path)
    verify.add_argument('--library-archive', type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'build':
            result = build_release(args.version, args.output_root, args.mod_cache, args.build_cache, args.library_archive)
        else:
            result = verify_release(args.release_directory, args.library_archive)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (ReleaseError, OSError, subprocess.CalledProcessError, KeyError, ValueError) as exc:
        # Subprocess stdout/stderr, raw environment and user inputs are never
        # reflected. Missing cache/toolchain remains an actionable local failure.
        if isinstance(exc, ReleaseError):
            message = str(exc)
        else:
            message = 'Local build/verification failed; inspect file availability, toolchain and offline cache'
        print('Release error: ' + message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
