#!/usr/bin/env python3
"""Explicit, server-side deployment of one new Portrait Studio service.

This program performs no SSH operations. Run it personally as root on the named
Ubuntu server, after reviewing the prepared bundle. Secrets read from Caddy are
kept in root-private files and are never printed. Existing app/service/prefix
targets are never replaced. Rollback retains all imported data.
"""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import platform
import re
import shutil
import ssl
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass

APP = Path('/home/ubuntu/portrait-studio')
STATE = APP / 'evidence/deployment-state.json'
CADDY = Path('/etc/caddy/Caddyfile')
UNIT = Path('/etc/systemd/system/portrait-studio.service')
ENABLED_UNIT = Path('/etc/systemd/system/multi-user.target.wants/portrait-studio.service')
SERVICE = 'portrait-studio.service'
HOST = 'dashboard-18-180-65-241.sslip.io'
PUBLIC = f'https://{HOST}/portrait-studio/'
PREFIX = '/portrait-studio/*'
LOOPBACK = 'http://127.0.0.1:4137'
MAX_TOTAL = 1 << 30
MAX_JSON = 32 << 20
MAX_BINARY = 64 << 20
HASH = re.compile(r'^[0-9a-f]{64}$')
STAGING = re.compile(r'^/tmp/portrait-studio-stage-[0-9a-f]{32}$')
IMAGE_PATH = re.compile(r'^photo_repo/assets/images/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:png|jpe?g|webp)$', re.I)
ARCHIVE_PATH = re.compile(r'^photo_repo/\.portrait-studio/imports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:manifest|mapping|source|report)\.json$')
ROUTE = '''    handle_path /portrait-studio/* {
        reverse_proxy 127.0.0.1:4137 {
            header_up Host 127.0.0.1:4137
        }
    }
'''
EXPECTED_UNIT = '''[Unit]
Description=Portrait Studio Go API
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/portrait-studio
ExecStart=/home/ubuntu/portrait-studio/bin/portrait-server -listen 127.0.0.1:4137 -data /home/ubuntu/portrait-studio/data/photo_repo -version remote-20261004
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
'''


class DeploymentError(Exception):
    """Contains safe diagnostics only; never include config or subprocess output."""


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(entries):
        result = {}
        for key, value in entries:
            require(key not in result, 'JSON contains duplicate keys.')
            result[key] = value
        return result
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(DeploymentError('Non-finite JSON number.')))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise DeploymentError('JSON is malformed or is not valid UTF-8.') from exc


def safe_member(name):
    if not isinstance(name, str) or not name or len(name) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        return False
    parts = name.split('/')
    return '\\' not in name and ':' not in name and len(parts) <= 8 and all(p and p not in ('.', '..') and len(p) <= 255 for p in parts) and parts[0] == 'photo_repo'


def allowed_member(name):
    return safe_member(name) and (name == 'photo_repo/.portrait-studio/library.json' or IMAGE_PATH.fullmatch(name) or ARCHIVE_PATH.fullmatch(name))


def no_links(path, missing_leaf=False):
    require(path.is_absolute(), 'A managed path must be absolute.')
    current = Path(path.anchor)
    for index, part in enumerate(path.parts[1:]):
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            require(missing_leaf and index == len(path.parts) - 2, 'A required managed ancestor is missing.')
            return None
        require(not stat.S_ISLNK(info.st_mode), 'A managed path contains a symbolic link.')
        if index < len(path.parts) - 2:
            require(stat.S_ISDIR(info.st_mode), 'A managed ancestor is not a directory.')
    return info


def read_file(path, maximum, owner=None):
    before = no_links(path)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'A managed file must be a regular file with one link.')
    if owner is not None:
        require(before.st_uid == owner, 'A managed file has an unexpected owner.')
    require(0 <= before.st_size <= maximum, 'A managed file exceeds its permitted size.')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'A managed file was replaced.')
        chunks, size = [], 0
        while True:
            chunk = os.read(descriptor, min(1 << 20, maximum + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            require(size <= maximum, 'A managed file grew beyond its permitted size.')
            chunks.append(chunk)
        after = os.fstat(descriptor)
        current = path.lstat()
        key = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(key(opened) == key(after) == key(current) and size == before.st_size, 'A managed file changed while it was read.')
        return b''.join(chunks), before
    finally:
        os.close(descriptor)


def check_static_elf(data):
    require(len(data) >= 64 and data[:7] == b'\x7fELF\x02\x01\x01', 'Binary must be a 64-bit little-endian ELF.')
    require(data[7] in (0, 3), 'Binary has an unsupported ELF ABI.')
    kind, machine = struct.unpack_from('<HH', data, 16)
    require(kind in (2, 3) and machine == 62, 'Binary must target Linux x86_64.')
    offset = struct.unpack_from('<Q', data, 32)[0]
    entry_size, count = struct.unpack_from('<HH', data, 54)
    require(entry_size == 56 and 1 <= count <= 1024 and offset + count * entry_size <= len(data), 'ELF program headers are invalid.')
    require(all(struct.unpack_from('<I', data, offset + n * entry_size)[0] != 3 for n in range(count)), 'Binary must be static; ELF interpreter is forbidden.')


def manifest_index(manifest):
    required = {'schemaVersion', 'root', 'count', 'revision', 'files', 'archiveSha256', 'archiveSize', 'totalSize', 'archiveFormat'}
    require(isinstance(manifest, dict) and set(manifest) == required, 'Library sidecar schema is unsupported.')
    require(manifest['schemaVersion'] == 1 and manifest['root'] == 'photo_repo' and manifest['count'] == 100 and manifest['revision'] == 3 and manifest['archiveFormat'] == 'tar.gz', 'Library sidecar must describe photo_repo with 100 items at revision 3.')
    require(isinstance(manifest['archiveSha256'], str) and HASH.fullmatch(manifest['archiveSha256']), 'Archive hash is invalid.')
    require(type(manifest['archiveSize']) is int and 1 <= manifest['archiveSize'] <= MAX_TOTAL, 'Archive size is invalid.')
    require(isinstance(manifest['files'], list) and 101 <= len(manifest['files']) <= 4096, 'Library file count is invalid.')
    files, total = {}, 0
    for entry in manifest['files']:
        require(isinstance(entry, dict) and set(entry) == {'path', 'size', 'sha256'}, 'Library sidecar file schema is unsupported.')
        name, size, digest = entry['path'], entry['size'], entry['sha256']
        require(allowed_member(name) and name not in files, 'Library sidecar has an unsafe, unsupported or duplicate path.')
        require(type(size) is int and 1 <= size <= MAX_JSON and isinstance(digest, str) and HASH.fullmatch(digest), 'Library sidecar file size or hash is invalid.')
        files[name] = entry
        total += size
    require(type(manifest['totalSize']) is int and total == manifest['totalSize'] and total <= MAX_TOTAL, 'Library sidecar total is invalid.')
    require('photo_repo/.portrait-studio/library.json' in files, 'Library index is missing.')
    require(sum(bool(IMAGE_PATH.fullmatch(name)) for name in files) == 100, 'Library must contain exactly 100 active images.')
    return files


def verify_index(data, files):
    index = strict_json(data)
    require(isinstance(index, dict) and index.get('schemaVersion') == 1 and index.get('revision') == 3 and isinstance(index.get('items'), list) and len(index['items']) == 100, 'Library index must have schema 1 and 100 items at revision 3.')
    ids, images = set(), set()
    for item in index['items']:
        require(isinstance(item, dict) and type(item.get('id')) is int and 1 <= item['id'] <= 100 and item['id'] not in ids, 'Library IDs must be unique integers from 1 to 100.')
        ids.add(item['id'])
        require(isinstance(item.get('label'), str) and 0 < len(item['label']) <= 160 and item.get('type') in ('photo', 'art'), 'Library metadata is invalid.')
        prompts = item.get('prompts')
        require(isinstance(prompts, dict) and set(prompts) == {'en', 'zh'} and all(isinstance(prompts[lang], str) and prompts[lang].strip() and '\0' not in prompts[lang] and len(prompts[lang].encode('utf-16-le')) // 2 <= 65536 for lang in ('en', 'zh')), 'Both complete prompts are required.')
        require(type(item.get('revision')) is int and item['revision'] >= 1 and item.get('mime') in ('image/png', 'image/jpeg', 'image/webp'), 'Library image metadata is invalid.')
        relative = item.get('imageRel')
        require(isinstance(relative, str) and IMAGE_PATH.fullmatch('photo_repo/' + relative) and relative not in images, 'Library image reference is unsafe or duplicate.')
        images.add(relative)
        entry = files.get('photo_repo/' + relative)
        require(entry and item.get('size') == entry['size'] and item.get('sha256') == entry['sha256'] and item.get('image') == PurePosixPath(relative).name, 'Image index does not match the sidecar.')
    require(ids == set(range(1, 101)), 'Library IDs 1 through 100 are required.')
    return index


class BoundedReader:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.count = stream, limit, 0
    def read(self, size=-1):
        wanted = min(size if size >= 0 else self.limit + 1, self.limit + 1 - self.count)
        data = self.stream.read(wanted)
        self.count += len(data)
        require(self.count <= self.limit, 'Archive decompressed bytes exceed the sidecar budget.')
        return data


def inspect_archive(archive, manifest, destination=None):
    """Validate each tar member; optional extraction writes only new owned files."""
    files = manifest_index(manifest)
    before = no_links(archive)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == manifest['archiveSize'], 'Compressed archive size or type differs from the sidecar.')
    descriptor = os.open(archive, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    found, index_bytes = set(), None
    try:
      with os.fdopen(descriptor, 'rb') as compressed:
        opened = os.fstat(compressed.fileno())
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'Compressed archive was replaced.')
        digest, size = hashlib.sha256(), 0
        while chunk := compressed.read(1 << 20):
            digest.update(chunk); size += len(chunk)
            require(size <= manifest['archiveSize'], 'Compressed archive grew beyond the sidecar size.')
        require(size == manifest['archiveSize'] and digest.hexdigest() == manifest['archiveSha256'], 'Compressed archive bytes do not match the sidecar.')
        compressed.seek(0)
        budget = manifest['totalSize'] + (2 * len(files) + 20) * 512
        decompressed = BoundedReader(gzip.GzipFile(fileobj=compressed, mode='rb'), budget)
        with tarfile.open(fileobj=decompressed, mode='r|', ignore_zeros=True) as container:
            for member in container:
                require(member.isfile() and member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and not member.pax_headers and not member.sparse and not member.linkname, 'Archive links, sparse files, devices and extended metadata are forbidden.')
                require(member.uid == 0 and member.gid == 0 and not member.uname and not member.gname, 'Archive identity metadata is unsupported.')
                require(member.name in files and member.name not in found and allowed_member(member.name), 'Archive has an unknown, duplicate or unsafe member.')
                expected = files[member.name]
                require(member.size == expected['size'], 'Archive member size differs from the sidecar.')
                stream = container.extractfile(member)
                require(stream is not None, 'Archive member is unreadable.')
                data = stream.read(member.size + 1)
                require(len(data) == member.size and sha256(data) == expected['sha256'], 'Archive member hash differs from the sidecar.')
                found.add(member.name)
                if member.name == 'photo_repo/.portrait-studio/library.json':
                    index_bytes = data
                if destination is not None:
                    target = destination / member.name
                    relative_parents = PurePosixPath(member.name).parts[:-1]
                    current = destination
                    for part in relative_parents:
                        current /= part
                        if not current.exists():
                            current.mkdir(mode=0o700)
                        info = no_links(current)
                        require(stat.S_ISDIR(info.st_mode), 'An extraction ancestor is not a directory.')
                    write_new(target, data, 0o600)
        require(found == set(files), 'Archive and sidecar members differ.')
        require(index_bytes is not None, 'Archive index is missing.')
        after, current = os.fstat(compressed.fileno()), archive.lstat()
        key = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(key(opened) == key(after) == key(current), 'Compressed archive changed during verification.')
        return verify_index(index_bytes, files)
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise DeploymentError('Archive is malformed or cannot be safely extracted.') from exc


@dataclass
class Token:
    value: str
    kind: str
    start: int
    end: int


@dataclass
class Node:
    header: list
    children: list | None
    start: int
    open_end: int = 0
    close_start: int = 0


def lex_caddy(text):
    tokens, i = [], 0
    while i < len(text):
        if text[i] in ' \t\r':
            i += 1
            continue
        if text[i] == '\n':
            tokens.append(Token('\n', 'newline', i, i + 1)); i += 1; continue
        if text[i] == '#':
            end = text.find('\n', i); i = len(text) if end < 0 else end; continue
        start = i
        if text[i] == '"':
            i += 1
            while i < len(text):
                if text[i] == '\\':
                    i += 2
                elif text[i] == '"':
                    i += 1
                    try:
                        value = json.loads(text[start:i])
                    except ValueError as exc:
                        raise DeploymentError('Unsupported Caddy quoted token.') from exc
                    tokens.append(Token(value, 'word', start, i)); break
                else:
                    i += 1
            else:
                raise DeploymentError('Unclosed Caddy quoted token.')
            continue
        require(text[i] != '`', 'Raw Caddy string syntax requires manual configuration review.')
        if text[i] in '{}' and (i + 1 == len(text) or text[i + 1].isspace() or text[i + 1] == '#'):
            tokens.append(Token(text[i], text[i], i, i + 1)); i += 1; continue
        while i < len(text) and not text[i].isspace() and text[i] != '#':
            require(text[i] not in '"`', 'Unsupported Caddy token syntax.')
            i += 1
        value = text[start:i]
        require(value and (('{' not in value and '}' not in value) or re.fullmatch(r'[^{}]*(?:\{[A-Za-z0-9_.$:-]+\}[^{}]*)+', value)), 'Unsupported inline Caddy brace syntax.')
        tokens.append(Token(value, 'word', start, i))
    return tokens


def parse_caddy(text):
    tokens = lex_caddy(text)
    position = 0
    def block(nested):
        nonlocal position
        result, header = [], []
        while position < len(tokens):
            token = tokens[position]; position += 1
            if token.kind == 'word':
                header.append(token)
            elif token.kind == '{':
                node = Node([t.value for t in header], [], header[0].start if header else token.start, token.end)
                header = []; node.children, node.close_start = block(True); result.append(node)
            elif token.kind in ('newline', '}'):
                if header:
                    result.append(Node([t.value for t in header], None, header[0].start)); header = []
                if token.kind == '}':
                    require(nested, 'Unexpected Caddy closing brace.'); return result, token.start
        require(not nested, 'Unclosed Caddy block.')
        if header:
            result.append(Node([t.value for t in header], None, header[0].start))
        return result, len(text)
    return block(False)[0]


def all_nodes(nodes):
    for node in nodes:
        yield node
        if node.children is not None:
            yield from all_nodes(node.children)


def candidate_caddy(original):
    try:
        text = original.decode('utf-8')
    except UnicodeError as exc:
        raise DeploymentError('Caddyfile is not valid UTF-8.') from exc
    nodes = parse_caddy(text)
    for node in all_nodes(nodes):
        require(not node.header or node.header[0] not in ('import', 'order'), 'Caddy imports or custom directive order require manual review.')
        require(not any(value.startswith('/portrait-studio') for value in node.header), 'The Portrait Studio prefix already exists.')
    require(all(not node.header or not node.header[0].startswith('(') for node in nodes), 'Caddy snippets require manual review.')
    matches = [node for node in nodes if node.header == [HOST] and node.children is not None]
    require(len(matches) == 1, 'One literal dashboard-only Caddy site block is required.')
    dashboard = matches[0]
    require(all(HOST not in node.header or node is dashboard for node in nodes), 'Shared or duplicate dashboard site blocks require manual review.')
    auth = [node for node in dashboard.children if node.header == ['basic_auth'] and node.children is not None]
    require(len(auth) == 1 and auth[0].children, 'Dashboard requires one unscoped global basic_auth block.')
    require(all(len(account.header) == 2 and account.children is None for account in auth[0].children), 'Global basic_auth accounts require manual review.')
    insertion = dashboard.close_start
    return (text[:insertion] + '\n' + ROUTE + text[insertion:]).encode('utf-8')


def prove_adapted_auth(config):
    """Prove actual adapted route order; a recursive occurrence is not proof."""
    servers = config.get('apps', {}).get('http', {}).get('servers', {}) if isinstance(config, dict) else {}
    require(isinstance(servers, dict) and servers, 'Adapted HTTP servers are missing.')
    selected = []
    for server in servers.values():
        require(isinstance(server, dict) and isinstance(server.get('routes'), list), 'Adapted server routes are unsupported.')
        for index, route in enumerate(server['routes']):
            for matcher in route.get('match', []):
                if HOST in matcher.get('host', []):
                    selected.append((server, index, route))
    require(len(selected) == 1, 'Adapted dashboard host scope is ambiguous.')
    server, position, route = selected[0]
    require(route.get('match') == [{'host': [HOST]}] and route.get('terminal') is True, 'Adapted dashboard host must be unconditional and terminal.')
    require(':443' in server.get('listen', []), 'Dashboard must be served on HTTPS port 443.')
    for earlier in server['routes'][:position]:
        matches = earlier.get('match')
        require(isinstance(matches, list) and matches and all(isinstance(m, dict) and set(m) == {'host'} and isinstance(m['host'],list) and m['host'] and all(isinstance(host,str) and re.fullmatch(r'[a-z0-9.-]+',host) and host != HOST for host in m['host']) for m in matches), 'An earlier top-level route could bypass dashboard authentication.')
    handlers = route.get('handle')
    require(isinstance(handlers, list) and len(handlers) == 1 and handlers[0].get('handler') == 'subroute', 'Adapted dashboard handler structure is unsupported.')
    routes = handlers[0].get('routes')
    require(isinstance(routes, list), 'Adapted dashboard routes are missing.')
    authenticated, prefixes = False, 0
    def possible_prefix(matchers):
        if not matchers:
            return True
        for matcher in matchers:
            require(isinstance(matcher, dict) and set(matcher) == {'path'}, 'Dashboard matcher structure requires manual review.')
            for value in matcher['path']:
                require(isinstance(value, str) and '?' not in value and '[' not in value and value.count('*') <= 1 and ('*' not in value or value.endswith('*')), 'Dashboard path matcher requires manual review.')
                matches_prefix = '/portrait-studio/healthz'.startswith(value[:-1]) if value.endswith('*') else value == '/portrait-studio/healthz'
                if matches_prefix:
                    return True
        return False
    for child in routes:
        require(isinstance(child, dict), 'Adapted dashboard child is invalid.')
        handles = child.get('handle', [])
        if any(h.get('handler') == 'authentication' for h in handles):
            require(not child.get('match') and not child.get('group') and not authenticated and len(handles) == 1, 'Authentication must be global, unconditional and unique.')
            authentication = handles[0]
            require(set(authentication) == {'handler', 'providers'}, 'Authentication handler has unsupported options.')
            providers = authentication['providers']
            require(isinstance(providers, dict) and set(providers) == {'http_basic'}, 'Only existing basic authentication is supported.')
            accounts = providers['http_basic'].get('accounts')
            require(isinstance(accounts, list) and accounts and all(isinstance(a, dict) and a.get('username') and a.get('password') for a in accounts), 'Adapted basic authentication accounts are missing.')
            authenticated = True; continue
        # handle_path may adapt as a prefix-matched subroute or as one grouping subroute.
        entries = [child]
        if not child.get('match') and len(handles) == 1 and handles[0].get('handler') == 'subroute':
            entries = handles[0].get('routes', [])
            require(isinstance(entries, list), 'Adapted grouped routes are invalid.')
        for entry in entries:
            matchers = entry.get('match')
            if matchers == [{'path': [PREFIX]}]:
                require(authenticated, 'Portrait prefix appears before global authentication.')
                target_handles = entry.get('handle', [])
                if len(target_handles) == 1 and target_handles[0].get('handler') == 'subroute':
                    inside = target_handles[0].get('routes', [])
                    require(isinstance(inside, list) and len(inside) == 1 and not inside[0].get('match'), 'Portrait prefix subroute is unsupported.')
                    target_handles = inside[0].get('handle', [])
                require(len(target_handles) == 2 and target_handles[0] == {'handler': 'rewrite', 'strip_path_prefix': '/portrait-studio'}, 'Portrait path stripping is unsupported.')
                proxy = target_handles[1]
                require(proxy.get('handler') == 'reverse_proxy' and proxy.get('upstreams') == [{'dial': '127.0.0.1:4137'}] and proxy.get('headers', {}).get('request', {}).get('set', {}).get('Host') == ['127.0.0.1:4137'], 'Portrait proxy destination or Host override is invalid.')
                require(set(proxy) <= {'handler', 'upstreams', 'headers'}, 'Portrait proxy has unsupported options.')
                prefixes += 1
            elif prefixes == 0:
                require(not possible_prefix(matchers), 'An earlier dashboard route could bypass the new prefix.')
    require(authenticated and prefixes == 1, 'Exactly one globally authenticated Portrait prefix is required.')


def write_new(path, data, mode):
    no_links(path.parent)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
    try:
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.fchmod(descriptor, mode)
    finally:
        os.close(descriptor)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_replace(path, data, expected_hash, mode, uid, gid):
    current, _ = read_file(path, MAX_JSON)
    require(sha256(current) == expected_hash, 'Managed file changed since review; refusing to overwrite it.')
    temporary = path.parent / ('.portrait-owned-' + uuid.uuid4().hex)
    write_new(temporary, data, mode)
    try:
        os.chown(temporary, uid, gid, follow_symlinks=False)
        latest, _ = read_file(path, MAX_JSON)
        require(sha256(latest) == expected_hash, 'Managed file changed before atomic installation.')
        os.replace(temporary, path); sync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


class Commands:
    def __init__(self, private):
        self.private = private
        self.counter = 0
        self.invocation = uuid.uuid4().hex
    def run(self, arguments, label, timeout=60):
        require(all(isinstance(arg, str) for arg in arguments), 'Command arguments must be fixed strings.')
        self.counter += 1
        stdout = self.private / f'{self.invocation}-{self.counter:03d}-{label}.stdout'
        stderr = self.private / f'{self.invocation}-{self.counter:03d}-{label}.stderr'
        write_new(stdout, b'', 0o600); write_new(stderr, b'', 0o600)
        with stdout.open('wb') as out, stderr.open('wb') as err:
            try:
                completed = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                           timeout=timeout, check=False, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise DeploymentError(f'{label} could not complete; private diagnostics were retained.') from exc
        require(completed.returncode == 0, f'{label} failed; private diagnostics were retained.')
        return read_file(stdout, MAX_JSON)[0]


def adapt_validate(candidate, commands):
    adapted = commands.run(['/usr/bin/caddy', 'adapt', '--config', str(candidate), '--adapter', 'caddyfile'], 'caddy-adapt')
    prove_adapted_auth(strict_json(adapted))
    commands.run(['/usr/bin/caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], 'caddy-validate')


def prove_effective_unit(output):
    try:
        lines=output.decode('utf-8').splitlines()
    except UnicodeError as exc:
        raise DeploymentError('Effective service properties are invalid.') from exc
    values={}
    for line in lines:
        require('=' in line,'Effective service property format is unsupported.')
        name,value=line.split('=',1);require(name not in values,'Effective service properties are duplicated.');values[name]=value
    require(set(values)=={'FragmentPath','User','Group','DropInPaths'} and values['FragmentPath']==str(UNIT) and values['User']=='ubuntu' and values['Group']=='ubuntu' and values['DropInPaths']=='','Existing systemd overrides prevent proof that the new service runs solely as ubuntu.')


def save_state(value):
    data = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    if STATE.exists():
        before, info = read_file(STATE, MAX_JSON, 0)
        require(stat.S_IMODE(info.st_mode) == 0o600, 'Deployment state permissions changed.')
        atomic_replace(STATE, data, sha256(before), 0o600, 0, 0)
    else:
        write_new(STATE, data, 0o600)


def rollback_guards(value, caddy_bytes, unit_bytes, app_info):
    require(value.get('schemaVersion') == 1 and value.get('app') == str(APP) and value.get('service') == SERVICE and value.get('caddy') == str(CADDY), 'Rollback state scope is invalid.')
    require(value.get('status') in ('preparing', 'active', 'failed', 'rollback-partial'), 'Deployment state cannot be rolled back again.')
    require((app_info.st_dev, app_info.st_ino) == (value.get('appDev'), value.get('appIno')) and app_info.st_uid == 0 and stat.S_ISDIR(app_info.st_mode), 'Owned application directory was replaced.')
    if unit_bytes is not None:
        require(sha256(unit_bytes) == value.get('unitSha256'), 'Service unit changed; rollback requires manual review.')
    elif value.get('unitInstalled'):
        require(value.get('unitRemovalPending') and value.get('serviceStarted') is False, 'Service unit disappeared; rollback requires manual review.')
    require(sha256(caddy_bytes) in (value.get('caddyBeforeSha256'),value.get('caddyAfterSha256')), 'Caddy changed beyond the known deployment images; rollback requires manual review.')


def rollback(value, commands):
    current_caddy, caddy_info = read_file(CADDY, MAX_JSON, 0)
    current_unit = read_file(UNIT, MAX_JSON, 0)[0] if os.path.lexists(UNIT) else None
    app_info = no_links(APP)
    rollback_guards(value, current_caddy, current_unit, app_info)
    require(stat.S_IMODE(caddy_info.st_mode) == value['caddyMode'] and caddy_info.st_uid == value['caddyUid'] and caddy_info.st_gid == value['caddyGid'], 'Caddy ownership or permissions changed.')
    backup_path = APP / 'evidence/Caddyfile.before'
    backup, info = read_file(backup_path, MAX_JSON, 0)
    require(stat.S_IMODE(info.st_mode) == 0o600 and sha256(backup) == value['caddyBeforeSha256'], 'Original Caddy backup changed.')
    commands.run(['/usr/bin/caddy', 'validate', '--config', str(backup_path), '--adapter', 'caddyfile'], 'rollback-caddy-validate')
    if sha256(current_caddy) == value['caddyAfterSha256']:
        atomic_replace(CADDY, backup, value['caddyAfterSha256'], value['caddyMode'], value['caddyUid'], value['caddyGid'])
    value['caddyInstalled'] = False; value['status'] = 'rollback-partial'; save_state(value)
    # Retrying a partial rollback also reloads the already restored bytes.
    rechecked,rechecked_info=read_file(CADDY,MAX_JSON,0)
    require(sha256(rechecked)==value['caddyBeforeSha256'] and stat.S_IMODE(rechecked_info.st_mode)==value['caddyMode'] and rechecked_info.st_uid==value['caddyUid'] and rechecked_info.st_gid==value['caddyGid'],'Caddy changed before rollback reload; preserving the operator configuration.')
    commands.run(['/usr/bin/systemctl', 'reload', 'caddy.service'], 'rollback-caddy-reload')
    if current_unit is not None:
        latest, _ = read_file(UNIT, MAX_JSON, 0)
        require(sha256(latest) == value['unitSha256'], 'Service unit changed before stopping it.')
        commands.run(['/usr/bin/systemctl', 'stop', SERVICE], 'rollback-owned-stop')
        commands.run(['/usr/bin/systemctl', 'disable', SERVICE], 'rollback-owned-disable')
        value['serviceStarted'] = False; value['unitRemovalPending'] = True; save_state(value)
        latest, _ = read_file(UNIT, MAX_JSON, 0)
        require(sha256(latest) == value['unitSha256'], 'Service unit changed before removing it.')
        UNIT.unlink(); sync_directory(UNIT.parent)
        value['unitInstalled'] = False; value['serviceStarted'] = False; save_state(value)
    commands.run(['/usr/bin/systemctl', 'daemon-reload'], 'rollback-daemon-reload')
    value['status'] = 'rolled-back'; value['rolledBackAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()); save_state(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def fetch(url, maximum=MAX_JSON):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=15) as response:
        data = response.read(maximum + 1)
        require(len(data) <= maximum, 'Verification response exceeds its permitted size.')
        return response.status, data


def probe_public_auth():
    for suffix in ('healthz', 'v1/library', 'v1/portraits/1', 'v1/images/1?revision=1', 'v1/batches/preview'):
        try:
            fetch(PUBLIC + suffix)
        except urllib.error.HTTPError as error:
            require(error.code == 401 and error.headers.get('WWW-Authenticate', '').lower().startswith('basic '), 'Public prefix did not require existing authentication.')
        except (OSError, urllib.error.URLError) as exc:
            raise DeploymentError('Public HTTPS verification failed using normal certificate verification.') from exc
        else:
            raise DeploymentError('Public prefix returned data without authentication.')


def verify_running(index):
    for attempt in range(20):
        try:
            status, data = fetch(LOOPBACK + '/healthz')
            health = strict_json(data)
            require(status == 200 and health.get('ok') is True and health.get('data', {}).get('status') == 'ok', 'Loopback health response is invalid.')
            break
        except (OSError, urllib.error.URLError):
            require(attempt < 19, 'Owned service did not become healthy.')
            time.sleep(0.5)
    _, data = fetch(LOOPBACK + '/v1/library')
    response = strict_json(data)
    snapshot = response.get('data', {})
    require(response.get('ok') is True and snapshot.get('configured') is True and snapshot.get('revision') == 3 and len(snapshot.get('items', [])) == 100, 'Owned service did not expose the prepared 100-item library.')
    clean = [{k: v for k, v in item.items() if k != 'image_url'} for item in snapshot['items']]
    require(clean == index['items'], 'Running service library differs from the prepared complete metadata.')


def apply(args):
    require(STAGING.fullmatch(args.staging or ''), 'Staging must be one exact /tmp/portrait-studio-stage-<32hex> directory.')
    stage = Path(args.staging)
    owner = pwd.getpwnam('ubuntu')
    info = no_links(stage)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner.pw_uid and stat.S_IMODE(info.st_mode) == 0o700, 'Staging must be an Ubuntu-owned private directory.')
    require(set(p.name for p in stage.iterdir()) == {'portrait-server', 'portrait-studio.service', 'photo-repo-100.tar.gz', 'photo-repo-100.tar.gz.manifest.json'}, 'Staging contains missing or unexpected files.')
    for digest in (args.binary_sha256, args.unit_sha256, args.manifest_sha256):
        require(isinstance(digest, str) and HASH.fullmatch(digest), 'Expected public bundle hashes are required.')
    binary, binary_info = read_file(stage / 'portrait-server', MAX_BINARY, owner.pw_uid)
    unit, unit_info = read_file(stage / 'portrait-studio.service', MAX_JSON, owner.pw_uid)
    sidecar, sidecar_info = read_file(stage / 'photo-repo-100.tar.gz.manifest.json', MAX_JSON, owner.pw_uid)
    for metadata in (binary_info, unit_info, sidecar_info):
        require(stat.S_IMODE(metadata.st_mode) & 0o022 == 0, 'Staging files must not be writable by other users.')
    require(sha256(binary) == args.binary_sha256 and sha256(unit) == args.unit_sha256 and sha256(sidecar) == args.manifest_sha256, 'Staging bytes do not match the reviewed public hashes.')
    check_static_elf(binary)
    require(unit.decode('utf-8') == EXPECTED_UNIT, 'Service unit differs from the fixed reviewed template.')
    manifest = strict_json(sidecar)
    archive = stage / 'photo-repo-100.tar.gz'
    archive_info = no_links(archive)
    require(archive_info.st_uid == owner.pw_uid and stat.S_IMODE(archive_info.st_mode) & 0o022 == 0, 'Archive ownership or permissions are unsafe.')
    index = inspect_archive(archive, manifest)
    require(not os.path.lexists(APP) and not os.path.lexists(UNIT) and not os.path.lexists(ENABLED_UNIT), 'An app directory, unit or enablement target already exists; no deployment writes were made.')
    require(all(not os.path.lexists(Path(root)/(SERVICE+'.d')) for root in ('/etc/systemd/system','/run/systemd/system','/usr/lib/systemd/system')), 'An existing service drop-in target requires manual review.')
    no_links(APP.parent); no_links(UNIT.parent)
    original, original_info = read_file(CADDY, MAX_JSON, 0)
    require(stat.S_IMODE(original_info.st_mode) & 0o022 == 0, 'Caddyfile is writable by non-root users.')
    candidate = candidate_caddy(original)
    private = Path(tempfile.mkdtemp(prefix='portrait-studio-caddy-', dir='/tmp'))
    os.chmod(private, 0o700)
    commands = Commands(private)
    candidate_file = private / 'Caddyfile.candidate'
    write_new(candidate_file, candidate, 0o600)
    # No app-directory writes occur until all archive, service, port and auth checks pass.
    require(commands.run(['/usr/bin/systemctl', 'show', '--property=LoadState', '--value', SERVICE], 'preflight-unit').strip() == b'not-found', 'The service name already exists in systemd.')
    require(not commands.run(['/usr/bin/ss', '-H', '-ltn', 'sport = :4137'], 'preflight-port').strip(), 'Port 4137 is already in use.')
    adapt_validate(candidate_file, commands)
    latest, _ = read_file(CADDY, MAX_JSON, 0)
    require(sha256(latest) == sha256(original), 'Caddyfile changed during review; no app-directory writes were made.')
    value = None
    try:
        APP.mkdir(mode=0o750)
        os.chown(APP, 0, owner.pw_gid, follow_symlinks=False)
        for directory in ('bin', 'data', 'evidence'):
            (APP / directory).mkdir(mode=0o700)
        os.chown(APP / 'bin', 0, owner.pw_gid, follow_symlinks=False); os.chmod(APP / 'bin', 0o750)
        app_info = APP.lstat()
        value = {'schemaVersion': 1, 'deploymentId': uuid.uuid4().hex, 'status': 'preparing', 'app': str(APP), 'appDev': app_info.st_dev, 'appIno': app_info.st_ino, 'service': SERVICE, 'caddy': str(CADDY),
                 'caddyBeforeSha256': sha256(original), 'caddyAfterSha256': sha256(candidate), 'caddyMode': stat.S_IMODE(original_info.st_mode), 'caddyUid': original_info.st_uid, 'caddyGid': original_info.st_gid,
                 'unitSha256': sha256(unit), 'binarySha256': sha256(binary), 'archiveSha256': manifest['archiveSha256'], 'manifestSha256': sha256(sidecar), 'unitInstalled': False, 'caddyInstalled': False, 'serviceStarted': False,
                 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'count': 100, 'revision': 3}
        write_new(APP / 'evidence/Caddyfile.before', original, 0o600); write_new(APP / 'evidence/Caddyfile.after', candidate, 0o600); save_state(value)
        commands = Commands(APP / 'evidence')
        write_new(APP / 'bin/portrait-server', binary, 0o750); os.chown(APP / 'bin/portrait-server', 0, owner.pw_gid, follow_symlinks=False)
        extracted = inspect_archive(archive, manifest, APP / 'data')
        require(extracted == index, 'Archive changed between review and extraction.')
        for root, directories, filenames in os.walk(APP / 'data', followlinks=False):
            for name in directories + filenames:
                target = Path(root) / name; no_links(target); os.chown(target, owner.pw_uid, owner.pw_gid, follow_symlinks=False)
        # Keep this ancestor root-private throughout extraction and all descendant chowns.
        os.chown(APP / 'data', owner.pw_uid, owner.pw_gid, follow_symlinks=False)
        write_new(APP / 'evidence/library.manifest.json', sidecar, 0o600)
        write_new(UNIT, unit, 0o644); sync_directory(UNIT.parent); value['unitInstalled'] = True; save_state(value)
        commands.run(['/usr/bin/systemctl', 'daemon-reload'], 'owned-daemon-reload')
        properties=commands.run(['/usr/bin/systemctl','show','--property=FragmentPath','--property=User','--property=Group','--property=DropInPaths',SERVICE],'owned-effective-unit')
        prove_effective_unit(properties)
        commands.run(['/usr/bin/systemctl', 'enable', SERVICE], 'owned-enable')
        commands.run(['/usr/bin/systemctl', 'start', SERVICE], 'owned-start'); value['serviceStarted'] = True; save_state(value)
        verify_running(index)
        atomic_replace(CADDY, candidate, value['caddyBeforeSha256'], value['caddyMode'], value['caddyUid'], value['caddyGid'])
        value['caddyInstalled'] = True; save_state(value)
        commands.run(['/usr/bin/systemctl', 'reload', 'caddy.service'], 'owned-caddy-reload')
        probe_public_auth()
        value['status'] = 'active'; value['verifiedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()); save_state(value)
        print(json.dumps({'status': 'deployed', 'count': 100, 'revision': 3, 'endpoint': PUBLIC, 'state': str(STATE)}))
    except Exception as exc:
        if value is not None:
            value['status'] = 'failed'; save_state(value)
            try:
                rollback(value, Commands(APP / 'evidence'))
            except Exception:
                value['status'] = 'rollback-partial'; save_state(value)
                raise DeploymentError('Deployment failed and guarded rollback could not finish. Data and private evidence are retained; operator review is required.') from exc
        reason=str(exc) if isinstance(exc,DeploymentError) else 'A local deployment operation failed.'
        raise DeploymentError(reason+' Guarded rollback retained all new data and application files for review.') from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description='Explicit manual deployment/guarded rollback of the fixed Portrait Studio server. No SSH or credential arguments are accepted.')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--apply', action='store_true'); action.add_argument('--rollback', action='store_true')
    parser.add_argument('--staging'); parser.add_argument('--binary-sha256'); parser.add_argument('--unit-sha256'); parser.add_argument('--manifest-sha256'); parser.add_argument('--state')
    args = parser.parse_args(argv)
    require(sys.platform.startswith('linux') and os.geteuid() == 0, 'Run this reviewed program personally as root on the intended Ubuntu server.')
    require(platform.machine() == 'x86_64', 'The intended server architecture is Linux x86_64.')
    os_release = read_file(Path('/usr/lib/os-release'),16 << 10,0)[0].decode('utf-8')
    require(re.search(r'^ID=ubuntu$',os_release,re.M) and re.search(r'^VERSION_ID="?24\.04"?$',os_release,re.M), 'The intended server OS is Ubuntu 24.04.')
    os.umask(0o077)
    if args.apply:
        require(args.state is None, '--apply does not accept a rollback state override.')
        apply(args)
    else:
        require(args.state == str(STATE) and all(value is None for value in (args.staging, args.binary_sha256, args.unit_sha256, args.manifest_sha256)), 'Rollback accepts only the fixed --state path.')
        data, info = read_file(STATE, MAX_JSON, 0); require(stat.S_IMODE(info.st_mode) == 0o600, 'Deployment state must remain root-private.')
        value = strict_json(data); rollback(value, Commands(APP / 'evidence'))
        print(json.dumps({'status': 'rolled-back', 'dataRetained': True, 'app': str(APP), 'state': str(STATE)}))


if __name__ == '__main__':
    try:
        main()
    except DeploymentError as error:
        print(str(error), file=sys.stderr); sys.exit(1)
    except Exception:
        print('Unexpected local deployment failure. Private evidence and all material data were retained; operator review is required.', file=sys.stderr); sys.exit(1)
