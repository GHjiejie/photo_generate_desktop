#!/usr/bin/env python3
"""Actual Darwin Go/HTTP acceptance using only a private copy of the 100-item archive.

No SSH, public network, production credentials, renderer, or Mac packages are used.
The fixture password is synthetic; passwords, PHC hashes and bearer values never
enter command arguments, logs or the evidence JSON. All owned children and test
files are removed in finally, including an unsuccessful run.
"""
import datetime
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import termios
import time

PROJECT = Path(__file__).resolve().parents[1]
ARCHIVE = PROJECT / 'server/dist/Portrait-Studio-Library-100-r3.tar.gz'
SIDECAR = Path(str(ARCHIVE) + '.manifest.json')
ORIGINAL = PROJECT / 'photo_repo'
LINUX_BINARY = PROJECT / 'server/dist/platform-auth/portrait-server-linux-amd64'
FIXTURE_PASSWORD = 'Isolated 100 portrait fixture 2026!'


class CheckFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckFailure(code)


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def fingerprint_file(filename):
    before = filename.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'SOURCE_FILE_TYPE')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        digest = hashlib.sha256()
        total = 0
        while raw := os.read(descriptor, 1 << 20):
            digest.update(raw)
            total += len(raw)
            require(total <= opened.st_size, 'SOURCE_GREW')
        after = os.fstat(descriptor)
        signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_mode)
        require(signature(before) == signature(opened) == signature(after) == signature(filename.lstat()), 'SOURCE_CHANGED')
        require(total == before.st_size, 'SOURCE_SIZE_CHANGED')
        return {'size': total, 'sha256': digest.hexdigest(), 'mode': oct(stat.S_IMODE(before.st_mode))}
    finally:
        os.close(descriptor)


def fingerprint_tree(root):
    require(root.resolve() == root and root.is_dir(), 'SOURCE_ROOT_NOT_CANONICAL')
    result = {}
    for directory, children, files in os.walk(root, followlinks=False):
        require(len(Path(directory).relative_to(root).parts) <= 12, 'SOURCE_DEPTH')
        for name in children:
            require(stat.S_ISDIR((Path(directory) / name).lstat().st_mode), 'SOURCE_SYMLINK')
        for name in files:
            filename = Path(directory) / name
            result[filename.relative_to(root).as_posix()] = fingerprint_file(filename)
            require(len(result) <= 5000, 'SOURCE_ENTRIES')
    return result


def tree_summary(value):
    return {'files': len(value), 'bytes': sum(row['size'] for row in value.values()),
            'sha256': sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())}


def sanitized_environment(private):
    # Never inspect or serialize the removed values; no inherited real auth config.
    env = {key: value for key, value in os.environ.items() if not key.startswith('PORTRAIT_STUDIO_')}
    env.update({'GOPROXY': 'off', 'GOSUMDB': 'off', 'GOTOOLCHAIN': 'local', 'GOWORK': 'off',
                'GOCACHE': '/tmp/portrait-admin-auth-buildcache', 'GOMODCACHE': '/tmp/portrait-admin-auth-modcache',
                'CGO_ENABLED': '0', 'GOOS': 'darwin', 'GOARCH': 'arm64', 'TMPDIR': str(private)})
    return env


def initialize_hidden(binary, auth_file, env):
    pid, descriptor = pty.fork()
    if pid == 0:
        os.execve(str(binary), [str(binary), 'init-admin', '-auth-file', str(auth_file)], env)
    buffer = b''
    prompts = [b'New admin password', b'Confirm admin password']
    deadline = time.monotonic() + 15
    status = None
    try:
        while time.monotonic() < deadline:
            done, observed_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = observed_status
                require(not prompts and os.waitstatus_to_exitcode(status) == 0, 'INITIALIZER_FAILED')
                break
            if select.select([descriptor], [], [], 0.1)[0]:
                try:
                    chunk = os.read(descriptor, 4096)
                except OSError:
                    chunk = b''
                buffer += chunk
                require(len(buffer) <= 16384 and FIXTURE_PASSWORD.encode() not in buffer, 'PTY_INPUT_ECHOED')
            if prompts and prompts[0] in buffer:
                # The prompt is written immediately before ReadPassword disables
                # echo. Wait for the actual terminal flag before sending input.
                hidden_deadline = time.monotonic() + 1
                while termios.tcgetattr(descriptor)[3] & termios.ECHO:
                    require(time.monotonic() < hidden_deadline, 'PTY_ECHO_STILL_ENABLED')
                    time.sleep(0.005)
                os.write(descriptor, FIXTURE_PASSWORD.encode() + b'\n')
                prompts.pop(0)
                buffer = b''
        else:
            raise CheckFailure('INITIALIZER_TIMEOUT')
        require(auth_file.is_file() and stat.S_IMODE(auth_file.stat().st_mode) == 0o600, 'AUTH_FILE_MODE')
    finally:
        buffer = b''
        os.close(descriptor)
        if status is None:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


def request(port, method, route, token=None, body=None, content_type=None):
    require(route.startswith('/v1/') or route == '/healthz', 'UNTRUSTED_ROUTE')
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if isinstance(body, dict):
        body = json.dumps(body, ensure_ascii=False).encode()
        content_type = 'application/json'
    if content_type:
        headers['Content-Type'] = content_type
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
    try:
        connection.request(method, route, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read((32 << 20) + 1)
        require(len(raw) <= 32 << 20, 'HTTP_RESPONSE_TOO_LARGE')
        return response.status, response.getheader('Content-Type'), raw
    finally:
        connection.close()
        headers.clear()


def json_request(port, method, route, token=None, body=None, expected=200, code=None, content_type=None):
    status, mime, raw = request(port, method, route, token, body, content_type)
    require(status == expected and mime and mime.startswith('application/json'), 'HTTP_STATUS_OR_TYPE')
    result = json.loads(raw)
    if code:
        require(result.get('ok') is False and result.get('error', {}).get('code') == code, 'HTTP_ERROR_CODE')
        return None
    require(result.get('ok') is True and isinstance(result.get('data'), dict), 'HTTP_ENVELOPE')
    return result['data']


def start_server(binary, data, auth_file, env, children, version):
    reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    finally:
        reservation.close()
    child = subprocess.Popen([str(binary), '-data', str(data), '-listen', f'127.0.0.1:{port}',
                              '-label', 'isolated-platform-auth-100', '-version', version,
                              '-auth-file', str(auth_file)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    children.append(child)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        require(child.poll() is None, 'OWNED_SERVER_EXITED')
        try:
            health = json_request(port, 'GET', '/healthz')
            require(health == {'status': 'ok', 'version': version} and child.poll() is None, 'OWNED_SERVER_HEALTH_IDENTITY')
            return child, port
        except (ConnectionError, OSError):
            time.sleep(0.03)
    raise CheckFailure('OWNED_SERVER_START_TIMEOUT')


def stop_server(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
    require(child.returncode == 0, 'OWNED_SERVER_SHUTDOWN')


def multipart(metadata, image):
    boundary = 'PortraitFixtureBoundary100'
    raw = b'--' + boundary.encode() + b'\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'
    raw += json.dumps(metadata, ensure_ascii=False).encode() + b'\r\n--' + boundary.encode()
    raw += b'\r\nContent-Disposition: form-data; name="image"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n'
    raw += image + b'\r\n--' + boundary.encode() + b'--\r\n'
    return raw, 'multipart/form-data; boundary=' + boundary


def clean_item(value):
    return {key: child for key, child in value.items() if key != 'image_url'}


def main():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    version = 'isolated-auth-100-' + stamp
    evidence = PROJECT / '.verification' / f'platform-auth-100-{stamp}.json'
    report = {'schemaVersion': 1, 'status': 'running', 'scope': {'actualHost': platform.system(), 'actualArchitecture': platform.machine(),
              'actualDarwinProductionBinary': False, 'actualHTTP': False, 'responsesMocked': False, 'network': 'literal IPv4 loopback only',
              'SSHUsed': False, 'publicNetworkUsed': False, 'productionCredentialsUsed': False, 'MacPackagesModified': False,
              'remoteDeploymentProven': False, 'testCredentials': 'synthetic fixture only; private PTY initializer, never reported'}, 'checks': []}
    private = None
    children = []
    before = None
    original_before = None
    token = None

    def stage(value):
        report['stage'] = value
        print(value, flush=True)

    try:
        require(platform.system() == 'Darwin' and platform.machine() == 'arm64', 'ACTUAL_MAC_ARCHITECTURE')
        stage('read-only-source-fingerprints')
        before = {'archive': fingerprint_file(ARCHIVE), 'sidecar': fingerprint_file(SIDECAR), 'linuxBinary': fingerprint_file(LINUX_BINARY)}
        original_before = fingerprint_tree(ORIGINAL)
        validator = module('isolated_archive_validator', PROJECT / 'server/deploy/deploy_server.py')
        provenance_validator = module('isolated_provenance_validator', PROJECT / 'server/deploy/prepare_library.py')
        validator.check_static_elf(LINUX_BINARY.read_bytes())
        report['linuxBinaryValidation'] = {'scope': 'static ELF headers/hash only; Linux binary was not executed on this Mac', **before['linuxBinary']}
        manifest = validator.strict_json(SIDECAR.read_bytes())
        private = Path(tempfile.mkdtemp(prefix='portrait-platform-auth-100-', dir='/tmp')).resolve()
        os.chmod(private, 0o700)
        env = sanitized_environment(private)
        binary = private / 'portrait-server-darwin-arm64'
        stage('offline-darwin-production-build')
        built = subprocess.run(['go', 'build', '-mod=readonly', '-trimpath', '-o', str(binary), './cmd/portrait-server'], cwd=PROJECT / 'server',
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        require(built.returncode == 0, 'OFFLINE_GO_BUILD_FAILED')
        report['darwinBinary'] = {**fingerprint_file(binary), 'builtFrom': 'server/cmd/portrait-server', 'dependenciesDownloaded': False}
        stage('strict-archive-validation-and-private-extraction')
        index = validator.inspect_archive(ARCHIVE, manifest, private)
        data = private / 'photo_repo'
        require(data.resolve() == data and data.is_relative_to(private) and data != ORIGINAL, 'ISOLATION_ROOT')
        original_copied_files = {entry['path']: entry for entry in manifest['files'] if entry['path'] != 'photo_repo/.portrait-studio/library.json'}
        stage('real-uninitialized-auth-boundary')
        auth_file = private / 'fixture-admin-auth.json'
        server, port = start_server(binary, data, auth_file, env, children, version)
        report['scope']['actualDarwinProductionBinary'] = True
        report['scope']['actualHTTP'] = True
        require(json_request(port, 'GET', '/v1/auth/status') == {'initialized': False, 'authenticated': False}, 'UNINITIALIZED_STATUS')
        json_request(port, 'GET', '/v1/library', expected=401, code='AUTH_NOT_INITIALIZED')
        json_request(port, 'POST', '/v1/auth/login', body={'username': 'admin', 'password': FIXTURE_PASSWORD}, expected=401, code='AUTH_NOT_INITIALIZED')
        stop_server(server)
        report['checks'].append('Actual uninitialized server rejects library access and fixed-admin login with AUTH_NOT_INITIALIZED.')
        stage('actual-hidden-pty-fixture-initialization')
        initialize_hidden(binary, auth_file, env)
        report['initializer'] = {'actualProductionCLI': True, 'controllingPTY': True, 'echoDisabledBeforeBothInputs': True, 'authFileMode': '0o600', 'privateParentMode': '0o700', 'hashOrPasswordReported': False}
        stage('real-fixed-admin-login-and-100-item-validation')
        server, port = start_server(binary, data, auth_file, env, children, version)
        require(json_request(port, 'GET', '/v1/auth/status') == {'initialized': True, 'authenticated': False}, 'INITIALIZED_STATUS')
        json_request(port, 'GET', '/v1/library', expected=401, code='AUTH_REQUIRED')
        json_request(port, 'POST', '/v1/auth/login', body={'username': 'admin', 'password': 'Wrong isolated fixture password!'}, expected=401, code='INVALID_CREDENTIALS')
        logged_in = json_request(port, 'POST', '/v1/auth/login', body={'username': 'admin', 'password': FIXTURE_PASSWORD})
        token = logged_in.pop('sessionToken')
        require(re.fullmatch(r'[A-Za-z0-9_-]{43}', token) is not None and logged_in['username'] == 'admin', 'SESSION_SHAPE')
        require(json_request(port, 'GET', '/v1/auth/session', token) == logged_in, 'SESSION_VERIFICATION')
        snapshot = json_request(port, 'GET', '/v1/library', token)
        require(snapshot['root'] == 'isolated-platform-auth-100' and snapshot['revision'] == 3 and len(snapshot['items']) == 100, 'FULL_LIBRARY_COUNT')
        expected_items = {value['id']: value for value in index['items']}
        require({value['id'] for value in snapshot['items']} == set(range(1, 101)), 'FULL_LIBRARY_IDS')
        images = []
        for value in snapshot['items']:
            expected_item = expected_items[value['id']]
            require(clean_item(value) == expected_item, 'INDEX_ALL_FIELDS_ROUNDTRIP')
            detail = json_request(port, 'GET', f"/v1/portraits/{value['id']}", token)
            require(clean_item(detail['item']) == expected_item, 'DETAIL_ALL_FIELDS_ROUNDTRIP')
            require(set(value['prompts']) == {'en', 'zh'} and all(value['prompts'][language].strip() for language in ('en', 'zh')), 'FULL_BILINGUAL_PROMPTS')
            provenance = value['sourceImport']
            require(isinstance(value['sourceMetadata'], dict) and isinstance(provenance, dict), 'SOURCE_FIELDS_MISSING')
            require(provenance['sourceHash'] == value['sha256'], 'SOURCE_HASH_BINDING')
            archive_rel = provenance['archiveRel']
            require(re.fullmatch(r'\.portrait-studio/imports/[0-9a-f-]{36}', archive_rel) is not None, 'SOURCE_ARCHIVE_REFERENCE')
            archived_manifest = (data / archive_rel / 'manifest.json').read_bytes()
            require(sha(archived_manifest) == provenance['manifestSha256'], 'SOURCE_MANIFEST_HASH_BINDING')
            document = validator.strict_json(archived_manifest)
            records = document if isinstance(document, list) else document['images']
            require(records[provenance['recordIndex']] == value['sourceMetadata'], 'SOURCE_ORIGINAL_RECORD_BINDING')
            mapping = validator.strict_json((data / archive_rel / 'mapping.json').read_bytes())
            mapped = [entry for entry in mapping if entry.get('recordIndex', entry.get('index')) == provenance['recordIndex']]
            require(len(mapped) == 1 and mapped[0].get('targetId', mapped[0].get('id')) == value['id'], 'SOURCE_TARGET_MAPPING_BINDING')
            if 'translationProvenance' in provenance or 'derivedChinesePrompt' in provenance:
                provenance_validator.validate_translation(value['sourceMetadata'], provenance, provenance.get('translationProvenance'),
                                                          int(value['sourceMetadata']['id']), provenance['recordIndex'], value['prompts'])
            image_status, image_mime, raw = request(port, 'GET', f"/v1/images/{value['id']}?revision={value['revision']}", token)
            require(image_status == 200 and image_mime == value['mime'] and len(raw) == value['size'] and sha(raw) == value['sha256'], 'IMAGE_HASH_MIME_SIZE')
            images.append({'id': value['id'], 'bytes': len(raw), 'sha256': sha(raw), 'mime': image_mime,
                           'enSha256': sha(value['prompts']['en'].encode()), 'zhSha256': sha(value['prompts']['zh'].encode()),
                           'allSourceFieldsExactlyPreserved': True})
        report['library'] = {'count': 100, 'revision': 3, 'fullBilingualPairs': 100, 'sourceMetadataAndImportPairs': 100,
                             'actualImageBytesVerified': 100, 'totalImageBytes': sum(value['bytes'] for value in images), 'items': images}
        report['checks'].append('All 100 actual API list/detail items exactly match every archived field; both full prompts and all 100 image byte hashes, MIME types, sizes and provenance bindings match.')
        stage('real-isolated-create-update-delete')
        image_bytes = (data / expected_items[1]['imageRel']).read_bytes()
        prompts = {'en': '  Isolated English prompt\n preserve all spaces. ', 'zh': '  隔离测试完整中文\n 保留所有空格。 '}
        metadata = {'id': 101, 'label': 'isolated CRUD fixture', 'type': 'photo', 'prompts': prompts, 'expectedVersion': 3}
        body, content_type = multipart(metadata, image_bytes)
        created = json_request(port, 'POST', '/v1/portraits', token, body, content_type=content_type)
        require(created['snapshot']['revision'] == 4 and len(created['snapshot']['items']) == 101 and created['item']['prompts'] == prompts, 'CREATE_ROUNDTRIP')
        updated_prompts = {'en': ' Updated full English\n\t prompt  ', 'zh': ' 修改后完整中文\n\t 提示词  '}
        update = {**metadata, 'label': 'updated isolated fixture', 'type': 'art', 'prompts': updated_prompts, 'expectedVersion': 4, 'expectedRevision': created['item']['revision']}
        changed = json_request(port, 'PATCH', '/v1/portraits/101', token, update)
        require(changed['snapshot']['revision'] == 5 and changed['item']['prompts'] == updated_prompts and changed['item']['type'] == 'art', 'UPDATE_ROUNDTRIP')
        detail = json_request(port, 'GET', '/v1/portraits/101', token)
        require(detail['item']['prompts'] == updated_prompts and detail['item']['label'] == update['label'], 'UPDATED_DETAIL_ROUNDTRIP')
        deleted = json_request(port, 'DELETE', '/v1/portraits/101', token, {'id': 101, 'expectedVersion': 5, 'expectedRevision': changed['item']['revision'], 'confirmed': True})
        require(deleted['deletedId'] == 101 and deleted.get('recoveryId') and deleted['snapshot']['revision'] == 6, 'DELETE_RECOVERY')
        final = json_request(port, 'GET', '/v1/library', token)
        require(len(final['items']) == 100 and {value['id']: clean_item(value) for value in final['items']} == expected_items, 'ORIGINAL_100_PRESERVED')
        report['crud'] = {'createdId': 101, 'createdCount': 101, 'createRevision': 4, 'updateRevision': 5, 'deleteRevision': 6,
                          'fullWhitespaceAndBilingualRoundtrip': True, 'deleteRecoveryConfirmed': True, 'original100AllFieldsUnchanged': True}
        stage('real-logout-session-revocation')
        require(json_request(port, 'DELETE', '/v1/auth/session', token) == {'loggedOut': True}, 'LOGOUT_ACKNOWLEDGEMENT')
        json_request(port, 'GET', '/v1/auth/session', token, expected=401, code='AUTH_REQUIRED')
        json_request(port, 'GET', '/v1/library', token, expected=401, code='AUTH_REQUIRED')
        token = None
        stop_server(server)
        report['logout'] = {'serverConfirmed': True, 'sameBearerRejectedBySessionAndLibrary': True, 'rejectedHTTPStatus': 401, 'rejectedCode': 'AUTH_REQUIRED'}
        for relative, expected_file in original_copied_files.items():
            current_file = fingerprint_file(private / relative)
            require(current_file['sha256'] == expected_file['sha256'] and current_file['size'] == expected_file['size'], 'ORIGINAL_COPIED_ASSET_CHANGED')
        report['checks'].append('Real authenticated CRUD adds, edits and deletes only record 101; original 100 records, images and imported provenance archives remain unchanged. Real logout revokes the same bearer on both protected routes.')
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'blocked' if isinstance(error, PermissionError) else 'failed'
        report['error'] = {'type': type(error).__name__, 'code': str(error) if isinstance(error, CheckFailure) else 'LOCAL_PERMISSION_DENIED' if isinstance(error, PermissionError) else 'ISOLATED_CHECK_FAILED'}
    finally:
        token = None
        for child in children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)
        report['ownedProcessesStopped'] = all(child.poll() is not None for child in children)
        if private:
            shutil.rmtree(private)
        report['allPrivateTestFilesRemoved'] = private is None or not private.exists()
        if before is not None and original_before is not None:
            after = {'archive': fingerprint_file(ARCHIVE), 'sidecar': fingerprint_file(SIDECAR), 'linuxBinary': fingerprint_file(LINUX_BINARY)}
            original_after = fingerprint_tree(ORIGINAL)
            report['preservation'] = {'archive': {'before': before['archive'], 'after': after['archive'], 'unchanged': before['archive'] == after['archive']},
                                      'sidecar': {'before': before['sidecar'], 'after': after['sidecar'], 'unchanged': before['sidecar'] == after['sidecar']},
                                      'linuxBinaryUnchanged': before['linuxBinary'] == after['linuxBinary'],
                                      'realPhotoRepo': {'before': tree_summary(original_before), 'after': tree_summary(original_after), 'unchanged': original_before == original_after}}
            if before != after or original_before != original_after:
                report['status'] = 'failed'
                report['error'] = {'code': 'ORIGINAL_SOURCE_PRESERVATION_FAILED'}
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        serialized = json.dumps(report, ensure_ascii=False, indent=2)
        require(FIXTURE_PASSWORD not in serialized and '$argon2id$' not in serialized and 'sessionToken' not in serialized and 'Bearer ' not in serialized, 'REPORT_SECRET_CONTENT')
        with evidence.open('x') as output:
            output.write(serialized + '\n')
        print(f"{report['status'].upper()}: {evidence}", flush=True)
    return 0 if report['status'] == 'passed' else 2


if __name__ == '__main__':
    raise SystemExit(main())
