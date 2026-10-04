"""Pure bounded validation for the pinned 100-item delivery; no network/process calls."""
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tarfile

MAX_TOTAL = 1 << 30
MAX_JSON = 32 << 20
MAX_BINARY = 64 << 20
HASH = re.compile(r'^[0-9a-f]{64}$')
IMAGE_PATH = re.compile(r'^photo_repo/assets/images/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?:png|jpe?g|webp)$', re.I)
ARCHIVE_PATH = re.compile(r'^photo_repo/\.portrait-studio/imports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(?:manifest|mapping|source|report)\.json$')

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


def write_new(path, data, mode):
    no_links(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def inspect_tree(root, manifest, *, allow_runtime_lock=False, lock_owner=None):
    """No writes: require the seed tree's exact files, bytes and complete index."""
    files = manifest_index(manifest)
    actual = set()
    for directory, folders, filenames in os.walk(root, followlinks=False):
        no_links(Path(directory))
        for name in folders:
            require(stat.S_ISDIR(no_links(Path(directory) / name).st_mode), 'Seed tree directory is unsafe.')
        for name in filenames:
            path = Path(directory) / name
            relative = 'photo_repo/' + path.relative_to(root).as_posix()
            if allow_runtime_lock and relative == 'photo_repo/.portrait-studio/go-store.lock':
                info = no_links(path)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == lock_owner and
                        stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0,
                        'Go runtime lock has unsafe identity, permissions or content.')
                # This process-owned zero-byte lock is not archived seed data.
                continue
            require(relative in files, 'Seed tree contains unexpected files.')
            data, info = read_file(path, MAX_JSON)
            expected = files[relative]
            require(info.st_size == expected['size'] and sha256(data) == expected['sha256'], 'Seed tree changed from the pinned 100-item delivery.')
            actual.add(relative)
    require(actual == set(files), 'Seed tree is incomplete.')
    data, _ = read_file(root / '.portrait-studio/library.json', MAX_JSON)
    return verify_index(data, files)
