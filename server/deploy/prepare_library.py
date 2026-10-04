#!/usr/bin/env python3
"""Read-only verification and exclusive creation of a deployable library archive.

Usage: python3 prepare_library.py --library ABSOLUTE_ROOT --output NEW.tar.gz
       --expected-count 100 --expected-revision 3

Requires the project's existing Go toolchain and cached official x/image module
for full PNG/JPEG/WebP decoding. No Store is opened and no source lock, index,
journal, image or archive is modified. The archive has only photo_repo/* files.
"""
from __future__ import annotations

import argparse
import atexit
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile

MAX_IMAGE = 30 << 20
MAX_JSON = 32 << 20
MAX_TOTAL = 1 << 30
MAX_ENTRIES = 20000
MAX_DEPTH = 12
ROOT_MEMBER = 'photo_repo'
INDEX = '.portrait-studio/library.json'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
IMPORT = re.compile(r'^\.portrait-studio/imports/(' + UUID + r')$')
IMAGE = re.compile(r'^assets/images/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(?i:png|jpe?g|webp)$')
HASH = re.compile(r'^[0-9a-f]{64}$')
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
DIRECTORY = getattr(os, 'O_DIRECTORY', 0)

class PreparationError(Exception):
    pass

def reject(message):
    raise PreparationError(message)

def safe_relative(name):
    if not isinstance(name, str) or not name or len(name) > 4096 or name.startswith('/'):
        return False
    if any(ord(c) < 32 or ord(c) == 127 for c in name) or '\\' in name or ':' in name:
        return False
    return all(p and p not in ('.', '..') and len(p.encode('utf-8')) <= 255 for p in name.split('/'))

def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def no_link_absolute(name):
    if not isinstance(name, str) or not os.path.isabs(name) or os.path.normpath(name) != name:
        reject('A clean absolute path is required')
    current = '/'
    for component in name.split('/')[1:]:
        if not component:
            continue
        current = os.path.join(current, component)
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode):
            reject('Symbolic links are not allowed: ' + current)
        if current != name and not stat.S_ISDIR(info.st_mode):
            reject('An ancestor is not a directory: ' + current)
    return os.lstat(name)

def open_directory_absolute(name):
    expected = no_link_absolute(name)
    if not stat.S_ISDIR(expected.st_mode):
        reject('Expected a directory: ' + name)
    current = os.open('/', os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
        for part in name.split('/')[1:]:
            if not part:
                continue
            info = os.stat(part, dir_fd=current, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                reject('Directory ancestor is not a real directory')
            child = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
            if identity(os.fstat(current)) != identity(info):
                reject('Directory changed while opening')
        if identity(os.fstat(current)) != identity(expected):
            reject('Directory path changed while opening')
        result, current = current, None
        return result, expected
    finally:
        if current is not None:
            os.close(current)

def strict_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            reject('JSON contains duplicate object keys')
        out[key] = value
    return out

def parse_json(raw, label):
    if not 0 < len(raw) <= MAX_JSON:
        reject('JSON exceeds its size limit: ' + label)
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=strict_object,
                          parse_constant=lambda value: reject('Non-finite JSON number'))
    except (UnicodeError, ValueError, TypeError) as error:
        raise PreparationError('Invalid JSON: ' + label) from error

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

class SourceTree:
    """All reads use directory descriptors and O_NOFOLLOW, with final rechecks."""
    def __init__(self, root):
        self.root = os.fspath(root)
        self.fd, info = open_directory_absolute(self.root)
        if identity(os.fstat(self.fd)) != identity(info):
            self.close()
            reject('Library root changed while opening')
        self.root_identity = identity(info)
        try:
            self.snapshot = self.scan()
        except Exception:
            self.close()
            raise

    def close(self):
        if getattr(self, 'fd', None) is not None:
            os.close(self.fd)
            self.fd = None

    def open(self, relative):
        if not safe_relative(relative):
            reject('Unsafe relative path: ' + str(relative))
        current = os.dup(self.fd)
        try:
            parts = relative.split('/')
            for n, part in enumerate(parts):
                expected = self.snapshot.get('/'.join(parts[:n + 1]))
                if expected is None:
                    reject('Required file is missing: ' + relative)
                flags = os.O_RDONLY | NOFOLLOW
                if n < len(parts) - 1:
                    flags |= DIRECTORY
                next_fd = os.open(part, flags, dir_fd=current)
                os.close(current)
                current = next_fd
                if identity(os.fstat(current)) != expected:
                    reject('Source file or ancestor changed: ' + relative)
            result, current = current, None
            return result
        finally:
            if current is not None:
                os.close(current)

    def read(self, relative, limit):
        fd = self.open(relative)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size < 1 or before.st_size > limit:
                reject('Required file is not a bounded regular file: ' + relative)
            chunks, count = [], 0
            while True:
                chunk = os.read(fd, min(1 << 20, limit + 1 - count))
                if not chunk:
                    break
                chunks.append(chunk)
                count += len(chunk)
                if count > limit:
                    reject('File exceeds its size limit: ' + relative)
            after = os.fstat(fd)
            if identity(before) != identity(after) or count != before.st_size:
                reject('Source file changed during read: ' + relative)
            return b''.join(chunks)
        finally:
            os.close(fd)

    def scan(self):
        current_root = no_link_absolute(self.root)
        if identity(current_root) != self.root_identity or stat.S_ISLNK(current_root.st_mode):
            reject('Library root was replaced or modified')
        if identity(os.fstat(self.fd)) != self.root_identity:
            reject('Opened root descriptor changed')
        found = {}
        def visit(fd, prefix, depth):
            if depth > MAX_DEPTH:
                reject('Library nesting exceeds the bounded scan')
            names = []
            with os.scandir(fd) as entries:
                for entry in entries:
                    if len(found) + len(names) >= MAX_ENTRIES:
                        reject('Library has too many entries')
                    names.append(entry.name)
            for name in sorted(names):
                relative = prefix + '/' + name if prefix else name
                if not safe_relative(relative):
                    reject('Unsafe library filename')
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    reject('Only real directories and regular files are allowed: ' + relative)
                found[relative] = identity(info)
                if len(found) > MAX_ENTRIES:
                    reject('Library has too many entries')
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd)
                    try:
                        if identity(os.fstat(child)) != identity(info):
                            reject('Directory changed while scanning: ' + relative)
                        visit(child, relative, depth + 1)
                    finally:
                        os.close(child)
        visit(self.fd, '', 0)
        return found

    def recheck(self):
        if self.scan() != self.snapshot:
            reject('Library tree changed; package was not accepted')

_GO_DECODER = r'''package main
import("bufio";"encoding/binary";"encoding/json";"fmt";"image";_ "image/jpeg";_ "image/png";_ "golang.org/x/image/webp";"bytes";"io";"os")
func main(){in:=bufio.NewReader(os.Stdin);out:=bufio.NewWriter(os.Stdout);defer out.Flush();for{var n uint32;if e:=binary.Read(in,binary.BigEndian,&n);e==io.EOF{return}else if e!=nil{fmt.Fprintln(os.Stderr,"invalid decoder input");os.Exit(2)};if n==0||n>30<<20{os.Exit(2)};b:=make([]byte,n);if _,e:=io.ReadFull(in,b);e!=nil{os.Exit(2)};result:=map[string]any{"ok":false};c,f,e:=image.DecodeConfig(bytes.NewReader(b));if e==nil&&c.Width>0&&c.Height>0&&c.Width<=12000&&c.Height<=12000&&int64(c.Width)*int64(c.Height)<=100000000{im,actual,e:=image.Decode(bytes.NewReader(b));if e==nil&&actual==f&&im.Bounds().Dx()==c.Width&&im.Bounds().Dy()==c.Height{m:=map[string]string{"png":"image/png","jpeg":"image/jpeg","webp":"image/webp"}[f];if m!=""{result=map[string]any{"ok":true,"mime":m,"width":c.Width,"height":c.Height}}}};json.NewEncoder(out).Encode(result);out.Flush()}}
'''
_decoder_temp = None
_decoder_binary = None

def decoder_binary():
    global _decoder_temp, _decoder_binary
    if _decoder_binary is not None:
        return _decoder_binary
    _decoder_temp = tempfile.TemporaryDirectory(prefix='portrait-library-decoder-')
    atexit.register(_decoder_temp.cleanup)
    source = Path(_decoder_temp.name) / 'decode.go'
    executable = Path(_decoder_temp.name) / 'decode'
    source.write_text(_GO_DECODER, encoding='utf-8')
    env = dict(os.environ, GOPROXY='off', GOSUMDB='off', GOTOOLCHAIN='local',
               GOCACHE=os.environ.get('GOCACHE', '/tmp/portrait-go-build-cache'),
               GOMODCACHE=os.environ.get('GOMODCACHE', '/tmp/portrait-go-mod-cache'))
    try:
        result = subprocess.run(['go', 'build', '-buildvcs=false', '-o', str(executable), str(source)],
                                cwd=Path(__file__).resolve().parents[1], env=env,
                                capture_output=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PreparationError('Full image decoding requires the existing Go toolchain') from error
    if result.returncode:
        reject('Unable to build the offline image decoder; cache official x/image dependency first')
    _decoder_binary = executable
    return executable

class RasterDecoder:
    def __init__(self):
        self.process = subprocess.Popen([str(decoder_binary())], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
    def validate(self, raw, expected_mime, label):
        if not 0 < len(raw) <= MAX_IMAGE:
            reject('Image exceeds 30 MiB: ' + label)
        try:
            self.process.stdin.write(struct.pack('>I', len(raw)))
            self.process.stdin.write(raw)
            self.process.stdin.flush()
            response = self.process.stdout.readline(1024)
            result = json.loads(response)
        except (OSError, ValueError) as error:
            raise PreparationError('Full image decoding failed: ' + label) from error
        if not result.get('ok') or expected_mime and result.get('mime') != expected_mime:
            reject('Image is invalid, exceeds 12000 pixels, or has a MIME mismatch: ' + label)
        return result

def valid_int(value, low=1, high=9007199254740991):
    return type(value) is int and low <= value <= high

def utf16_length(text):
    return len(text.encode('utf-16-le')) // 2

def prompt(value):
    return isinstance(value, str) and bool(value.strip()) and '\0' not in value and utf16_length(value) <= 65536

def collect_members(tree, expected_count, expected_revision, decoder):
    raw_index = tree.read(INDEX, MAX_JSON)
    index = parse_json(raw_index, INDEX)
    if not isinstance(index, dict) or type(index.get('schemaVersion')) is not int or index.get('schemaVersion') != 1 or not valid_int(index.get('revision')):
        reject('Library index must use schema 1 with a valid revision')
    if 'updatedAt' in index and not isinstance(index['updatedAt'], str):
        reject('Index updatedAt must be a string')
    items = index.get('items')
    if not isinstance(items, list) or len(items) > 10000 or len(items) != expected_count or index['revision'] != expected_revision:
        reject('Library count or revision differs from the explicitly expected values')
    members = {}
    def add(relative, raw):
        if relative in members:
            return
        members[relative] = {'path': ROOT_MEMBER + '/' + relative, 'size': len(raw), 'sha256': sha(raw)}
        if sum(v['size'] for v in members.values()) > MAX_TOTAL:
            reject('Deployable library exceeds 1 GiB')
    add(INDEX, raw_index)
    # Preserve the entire original archive set, including the original report.
    archive_members = {}
    for relative, sig in tree.snapshot.items():
        if not relative.startswith('.portrait-studio/imports/') or not stat.S_ISREG(sig[2]):
            continue
        parent, name = relative.rsplit('/', 1)
        if not IMPORT.fullmatch(parent) or name not in ('manifest.json', 'mapping.json', 'source.json', 'report.json'):
            reject('Unexpected import archive file: ' + relative)
        raw = tree.read(relative, MAX_JSON)
        archive_members[relative] = raw
        parse_json(raw, relative)
        add(relative, raw)
    ids, image_paths = set(), set()
    for item in items:
        if not isinstance(item, dict) or not valid_int(item.get('id'), high=999999) or item['id'] in ids:
            reject('Library has an invalid or duplicate ID')
        ids.add(item['id'])
        label = item.get('label')
        prompts = item.get('prompts')
        if not isinstance(label, str) or not label.strip() or utf16_length(label) > 160 or any(ord(c) < 32 or ord(c) == 127 for c in label):
            reject('Library label is invalid')
        if item.get('type') not in ('photo', 'art') or not valid_int(item.get('revision')) or not isinstance(prompts, dict) or not all(prompt(prompts.get(lang)) for lang in ('en', 'zh')):
            reject('Each item requires a valid type, revision and complete bilingual prompts')
        relative = item.get('imageRel')
        if not isinstance(relative, str) or not IMAGE.fullmatch(relative) or relative in image_paths or item.get('image') != PurePosixPath(relative).name:
            reject('Library has an unsafe or duplicate image path')
        image_paths.add(relative)
        mime = item.get('mime')
        allowed_extensions = {'image/png': ('.png',), 'image/jpeg': ('.jpg', '.jpeg'), 'image/webp': ('.webp',)}
        if mime not in allowed_extensions or PurePosixPath(relative).suffix.lower() not in allowed_extensions[mime] or not valid_int(item.get('size'), high=MAX_IMAGE) or not isinstance(item.get('sha256'), str) or not HASH.fullmatch(item['sha256']):
            reject('Indexed image size, SHA-256 or format is invalid')
        raw = tree.read(relative, MAX_IMAGE)
        if len(raw) != item['size'] or sha(raw) != item['sha256']:
            reject('Indexed image size/hash differs: ' + relative)
        decoder.validate(raw, mime, relative)
        add(relative, raw)
        original, source = item.get('sourceMetadata'), item.get('sourceImport')
        if 'sourceMetadata' in item or 'sourceImport' in item:
            if not isinstance(original, dict) or not isinstance(source, dict) or not IMPORT.fullmatch(str(source.get('archiveRel', ''))):
                reject('Invalid original metadata or import provenance')
            source_name = source.get('sourceFileName')
            if not safe_relative(source_name) or '/' in source_name or source.get('typeOrigin') not in ('source', 'selected-default'):
                reject('Source filename or type origin is invalid')
            if 'sourceRelativePath' in source:
                source_relative = source['sourceRelativePath']
                if not safe_relative(source_relative) or PurePosixPath(source_relative).name != source_name:
                    reject('Source relative path is invalid')
            archive = source['archiveRel']
            for filename in ('manifest.json', 'mapping.json', 'source.json'):
                if archive + '/' + filename not in archive_members:
                    reject('Referenced source archive is missing: ' + archive + '/' + filename)
            manifest_raw = archive_members[archive + '/manifest.json']
            if source.get('manifestSha256') != sha(manifest_raw):
                reject('Source manifest hash differs from the archived raw JSON')
            manifest = parse_json(manifest_raw, archive + '/manifest.json')
            rows = manifest if isinstance(manifest, list) else manifest.get('images') if isinstance(manifest, dict) else None
            record_index = source.get('recordIndex')
            if not isinstance(rows, list) or len(rows) > 500 or not valid_int(record_index, low=0, high=499) or record_index >= len(rows) or json.dumps(rows[record_index], sort_keys=True, separators=(',', ':'), ensure_ascii=False) != json.dumps(original, sort_keys=True, separators=(',', ':'), ensure_ascii=False):
                reject('Original source record differs from its exact archived manifest')
            raw_id = original.get('id')
            if isinstance(raw_id, str) and re.fullmatch(r'\d{1,6}', raw_id):
                raw_id = int(raw_id)
            if not valid_int(raw_id, high=999999) or not valid_int(source.get('sourceId', raw_id), high=999999) or source.get('sourceId', raw_id) != raw_id or not isinstance(source.get('sourceHash'), str) or not HASH.fullmatch(source['sourceHash']):
                reject('Original source ID/hash is invalid')
            mapping = parse_json(archive_members[archive + '/mapping.json'], archive + '/mapping.json')
            mapped = [row for row in mapping if isinstance(row, dict) and row.get('recordIndex', row.get('index')) == record_index] if isinstance(mapping, list) else []
            if len(mapped) != 1 or mapped[0].get('targetId', mapped[0].get('id')) != item['id']:
                reject('Archived source/target ID mapping differs')
            provenance = source.get('translationProvenance')
            if 'translationProvenance' in source or 'derivedChinesePrompt' in source:
                validate_translation(original, source, provenance, raw_id, record_index, item['prompts'])
    # Recovery archives are included only from recognized store-owned names;
    # process locks, transaction directories and staging are never included.
    for relative, sig in tree.snapshot.items():
        if not relative.startswith('.portrait-studio/recovery/') or not stat.S_ISREG(sig[2]):
            continue
        parts = relative.split('/')[2:]
        if not parts or not re.fullmatch(UUID + r'(?:-abandoned-preview|-incomplete-transaction)?', parts[0]) or len(parts) > 5:
            reject('Unrecognized recovery archive path')
        name = parts[-1]
        allowed = name in ('item.json', 'journal.json', 'before.json', 'after.json', 'manifest.json', 'mapping.json', 'source.json') or re.fullmatch(r'(?:new|image)-\d{4}', name) or IMAGE.fullmatch('assets/images/' + name) or re.fullmatch(r'\d{4}-(?:item|manifest|mapping|source)\.json', name)
        if not allowed:
            reject('Unrecognized recovery file: ' + relative)
        raw = tree.read(relative, MAX_JSON if name.endswith('.json') else MAX_IMAGE)
        if name.endswith('.json'):
            parse_json(raw, relative)
        else:
            decoder.validate(raw, None, relative)
        add(relative, raw)
    return index, members

def validate_translation(original, source, provenance, source_id, record_index, target_prompts):
    if not isinstance(provenance, dict) or len(provenance) != 10 or provenance.get('kind') != 'derived-translation' or provenance.get('origin') != 'assistant-translation' or provenance.get('sourceLanguage') != 'en' or provenance.get('targetLanguage') != 'zh' or not valid_int(provenance.get('sourceId'), high=999999) or provenance.get('sourceId') != source_id or not valid_int(provenance.get('recordIndex'), low=0, high=499) or provenance.get('recordIndex') != record_index or provenance.get('manifestSha256') != source.get('manifestSha256'):
        reject('Derived translation provenance is invalid')
    field = next((f for f in ('prompt_en', 'prompt', 'prompts.en') if f in original or f == 'prompts.en' and isinstance(original.get('prompts'), dict) and 'en' in original['prompts']), None)
    english = original.get('prompts', {}).get('en') if field == 'prompts.en' else original.get(field)
    derived = source.get('derivedChinesePrompt')
    if not prompt(english) or not prompt(derived) or target_prompts.get('en') != english or target_prompts.get('zh') != derived or provenance.get('sourcePromptField') != field or provenance.get('sourcePromptSha256') != sha(english.encode()) or provenance.get('translatedPromptSha256') != sha(derived.encode()) or any(key in original for key in ('prompt_cn', 'prompt_zh')) or isinstance(original.get('prompts'), dict) and 'zh' in original['prompts']:
        reject('Derived Chinese translation does not match its preserved English source')

class HashWriter:
    def __init__(self, file):
        self.file = file
        self.hash = hashlib.sha256()
        self.size = 0
    def write(self, data):
        count = self.file.write(data)
        self.hash.update(data[:count])
        self.size += count
        return count
    def flush(self):
        self.file.flush()

def exclusive_file(path, parent_fd):
    return os.open(os.path.basename(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent_fd)

def remove_owned(path, info, parent_fd):
    try:
        current = os.stat(os.path.basename(path), dir_fd=parent_fd, follow_symlinks=False)
        if current.st_dev == info.st_dev and current.st_ino == info.st_ino and stat.S_ISREG(current.st_mode):
            os.unlink(os.path.basename(path), dir_fd=parent_fd)
    except FileNotFoundError:
        pass

def prepare_library(library, output, expected_count, expected_revision):
    library, output = os.fspath(library), os.fspath(output)
    if not valid_int(expected_count, low=0, high=10000) or not valid_int(expected_revision):
        reject('Expected count and revision must be explicit valid integers')
    if not os.path.isabs(output) or os.path.normpath(output) != output or not output.endswith('.tar.gz'):
        reject('Output must be a clean absolute new .tar.gz path')
    if not safe_relative(os.path.basename(output)) or len(os.path.basename(output + '.manifest.json').encode()) > 255:
        reject('Unsafe output filename')
    parent = os.path.dirname(output)
    parent_info = no_link_absolute(parent)
    if output == library or os.path.commonpath([library, output]) == library:
        reject('Output cannot be placed inside the source library')
    sidecar = output + '.manifest.json'
    for candidate in (output, sidecar):
        if os.path.lexists(candidate):
            reject('Output already exists; it will not be replaced: ' + candidate)
    parent_fd, parent_info = open_directory_absolute(parent)
    opened_parent = os.fstat(parent_fd)
    if (opened_parent.st_dev, opened_parent.st_ino) != (parent_info.st_dev, parent_info.st_ino):
        os.close(parent_fd)
        reject('Output directory changed while opening')
    tree, decoder = None, None
    created = []
    try:
        tree = SourceTree(library)
        decoder = RasterDecoder()
        index, members = collect_members(tree, expected_count, expected_revision, decoder)
        tree.recheck()
        fd = exclusive_file(output, parent_fd)
        created.append((output, os.fstat(fd)))
        with os.fdopen(fd, 'wb') as raw_output:
            writer = HashWriter(raw_output)
            with gzip.GzipFile(filename='', mode='wb', fileobj=writer, mtime=0) as zipped:
                with tarfile.open(fileobj=zipped, mode='w', format=tarfile.PAX_FORMAT) as archive:
                    for relative in sorted(members):
                        record = members[relative]
                        raw = tree.read(relative, MAX_IMAGE if relative.startswith('assets/images/') else MAX_JSON)
                        if len(raw) != record['size'] or sha(raw) != record['sha256']:
                            reject('Source changed after validation: ' + relative)
                        info = tarfile.TarInfo(record['path'])
                        info.size = len(raw)
                        info.mode = 0o600
                        info.uid = info.gid = 0
                        info.mtime = 0
                        archive.addfile(info, io.BytesIO(raw))
            writer.flush()
            os.fsync(raw_output.fileno())
            archive_sha, archive_size = writer.hash.hexdigest(), writer.size
        tree.recheck()
        manifest = {'schemaVersion': 1, 'root': ROOT_MEMBER, 'count': len(index['items']),
                    'revision': index['revision'], 'archiveFormat': 'tar.gz',
                    'archiveSha256': archive_sha, 'archiveSize': archive_size,
                    'totalSize': sum(v['size'] for v in members.values()),
                    'files': [members[relative] for relative in sorted(members)]}
        raw_manifest = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        fd = exclusive_file(sidecar, parent_fd)
        created.append((sidecar, os.fstat(fd)))
        with os.fdopen(fd, 'wb') as target:
            target.write(raw_manifest)
            target.flush()
            os.fsync(target.fileno())
        tree.recheck()
        current_parent = no_link_absolute(parent)
        if (current_parent.st_dev, current_parent.st_ino) != (opened_parent.st_dev, opened_parent.st_ino):
            reject('Output directory was replaced')
        os.fsync(parent_fd)
        return {'archive': output, 'manifest': sidecar, 'count': manifest['count'],
                'revision': manifest['revision'], 'files': len(manifest['files']),
                'archiveSha256': archive_sha, 'archiveSize': archive_size,
                'totalSize': manifest['totalSize'], 'manifestSha256': sha(raw_manifest)}
    except Exception:
        for path, info in reversed(created):
            remove_owned(path, info, parent_fd)
        raise
    finally:
        if decoder is not None:
            decoder.close()
        if tree is not None:
            tree.close()
        os.close(parent_fd)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--expected-count', required=True, type=int)
    parser.add_argument('--expected-revision', required=True, type=int)
    args = parser.parse_args()
    try:
        report = prepare_library(args.library, args.output, args.expected_count, args.expected_revision)
    except (PreparationError, OSError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps({'ok': True, **report}, ensure_ascii=False))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
