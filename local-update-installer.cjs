const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const PREFIX = '.portrait-update-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const MAX_ZIP = 1024 * 1024 * 1024;
const MAX_EXPANDED = 2 * 1024 * 1024 * 1024;
const ACK_ARGUMENT = '--portrait-update-ack=';

class UpdateInstallError extends Error {
  constructor(code, message, cause) { super(message, cause ? { cause } : undefined); this.name = 'UpdateInstallError'; this.code = code; }
}
const fail = (code, message) => { throw new UpdateInstallError(code, message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (stat, expected) => stat.dev === expected.dev && stat.ino === expected.ino;
function checkAbort(signal) {
  if (signal?.aborted) fail('ABORTED', '更新交接已取消，应用没有退出或被替换。');
}

function version(value) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part))) || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) fail('INVALID_VERSION', '更新版本号不是有效的语义化版本。');
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') || [] };
}
function compareVersions(left, right) {
  const a = version(left), b = version(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

async function noLinks(absolute, type) {
  if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || absolute.includes('\0')) fail('UNSAFE_PATH', '更新路径无效。');
  const requested = path.resolve(absolute);
  const final = await fs.lstat(requested);
  if (final.isSymbolicLink()) fail('UNSAFE_PATH', '更新来源和应用路径不能是符号链接。');
  let requestedComponent = path.parse(requested).root;
  for (const part of requested.slice(requestedComponent.length).split(path.sep).filter(Boolean)) {
    requestedComponent = path.join(requestedComponent, part);
    const component = await fs.lstat(requestedComponent);
    if (component.isSymbolicLink() && !(requestedComponent === '/tmp' && await fs.realpath(requestedComponent) === '/private/tmp' || requestedComponent === '/var' && await fs.realpath(requestedComponent) === '/private/var')) fail('UNSAFE_PATH', '更新路径包含符号链接。');
  }
  const real = await fs.realpath(requested);
  let current = path.parse(real).root;
  for (const part of real.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) fail('UNSAFE_PATH', '更新路径包含符号链接。');
  }
  if (type === 'file' && !final.isFile() || type === 'directory' && !final.isDirectory()) fail('UNSAFE_PATH', '更新路径类型不正确。');
  return real;
}
async function readFile(absolute, maximum = MAX_ZIP) {
  const target = await noLinks(absolute, 'file');
  const handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) fail('INVALID_PACKAGE', '更新包超过允许大小。');
    // Allocate only the observed, capped size; a growing source cannot make
    // readFile allocate unbounded memory before the post-read check.
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) fail('CONFLICT', '更新文件在读取时被截断。');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    const current = await fs.lstat(await noLinks(target, 'file'));
    if (extra.bytesRead || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !sameIdentity(current, identity(before))) fail('CONFLICT', '更新文件在读取时被修改。');
    return { bytes, stat: before, path: target };
  } finally { await handle.close(); }
}
async function syncDirectory(directory) {
  const handle = await fs.open(await noLinks(directory, 'directory'), constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeNew(file, bytes, mode = 0o600) {
  await noLinks(path.dirname(file), 'directory');
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
async function writeState(root, value) {
  await ownedRoot(root);
  const temporary = path.join(root, `.state-${crypto.randomUUID()}.json`);
  await writeNew(temporary, json(value));
  const destination = path.join(root, 'state.json');
  const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail('UNSAFE_PATH', '更新状态文件被替换。');
  await fs.rename(temporary, destination);
  await syncDirectory(root);
}
async function ownedRoot(root) {
  const real = await noLinks(root, 'directory');
  const stat = await fs.lstat(real);
  const nonce = path.basename(real).slice(PREFIX.length);
  if (!path.basename(real).startsWith(PREFIX) || !UUID.test(nonce) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('UNSAFE_PATH', '更新暂存目录不是当前应用创建的私有目录。');
  return { root: real, nonce, stat };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function safeEntry(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '.' || part === '..' || !part && part !== name.split('/').at(-1))) fail('UNSAFE_PACKAGE', 'ZIP 包含越界路径。');
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!trimmed || trimmed.split('/').some(part => !part || part.includes(':'))) fail('UNSAFE_PACKAGE', 'ZIP 包含无效路径。');
  return trimmed;
}
function inspectExtra(bytes, offset, length) {
  const end = offset + length, seen = new Set();
  while (offset < end) {
    if (offset + 4 > end) fail('INVALID_PACKAGE', 'ZIP 扩展字段损坏。');
    const tag = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2); offset += 4;
    if (offset + size > end || seen.has(tag)) fail('INVALID_PACKAGE', 'ZIP 扩展字段越界或重复。');
    seen.add(tag);
    // These fields contain timestamps or UID/GID only. Path/Unicode/ZIP64/
    // Unix-link extra semantics are rejected instead of delegated to ditto.
    if (tag === 0x5855) { if (![8, 12].includes(size)) fail('UNSAFE_PACKAGE', 'ZIP Unix 元数据长度无效。'); }
    else if (tag === 0x5455) { if (![5, 9, 13].includes(size) || bytes[offset] & ~7) fail('UNSAFE_PACKAGE', 'ZIP 时间元数据无效。'); }
    else if (tag === 0x7875) {
      if (size < 5 || bytes[offset] !== 1) fail('UNSAFE_PACKAGE', 'ZIP 用户元数据无效。');
      const uidLength = bytes[offset + 1], gidPosition = offset + 2 + uidLength;
      if (!uidLength || uidLength > 8 || gidPosition >= offset + size || !bytes[gidPosition] || bytes[gidPosition] > 8 || gidPosition + 1 + bytes[gidPosition] !== offset + size) fail('UNSAFE_PACKAGE', 'ZIP 用户元数据无效。');
    } else fail('UNSAFE_PACKAGE', 'ZIP 包含不支持的路径或链接扩展字段。');
    offset += size;
  }
}
function inspectZip(bytes, bundleName) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('INVALID_PACKAGE', 'ZIP 结构无效或使用了不支持的分卷格式。');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (!count || count > 30000 || count === 65535 || centralOffset + centralSize !== end || bytes.readUInt16LE(end + 8) !== count) fail('INVALID_PACKAGE', 'ZIP 索引无效或使用了不支持的 ZIP64 格式。');
  const entries = new Map(), names = new Set(), spans = [];
  let cursor = centralOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('INVALID_PACKAGE', 'ZIP 索引损坏。');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), attributes = bytes.readUInt32LE(cursor + 38), offset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & ~0x080e || ![0, 8].includes(method) || [compressed, size, offset].includes(0xffffffff)) fail('INVALID_PACKAGE', 'ZIP 条目使用了不支持的编码或压缩格式。');
    inspectExtra(bytes, cursor + 46 + nameLength, extraLength);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), rawName = nameBytes.toString('utf8');
    if (!Buffer.from(rawName).equals(nameBytes)) fail('UNSAFE_PACKAGE', 'ZIP 文件名不是有效的 UTF-8。');
    const name = safeEntry(rawName), normalized = name.normalize('NFC').toLowerCase();
    if (names.has(normalized)) fail('UNSAFE_PACKAGE', 'ZIP 包含重复或大小写冲突的路径。');
    names.add(normalized);
    if (!(name === bundleName || name.startsWith(`${bundleName}/`) || name === '__MACOSX' || name === `__MACOSX/${bundleName}` || name.startsWith(`__MACOSX/${bundleName}/`))) fail('UNSAFE_PACKAGE', 'ZIP 必须只包含对应的应用包和 AppleDouble 元数据。');
    if (offset + 30 > centralOffset || bytes.readUInt32LE(offset) !== 0x04034b50) fail('INVALID_PACKAGE', 'ZIP 本地条目损坏。');
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28);
    if (bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(nameBytes)) fail('UNSAFE_PACKAGE', 'ZIP 本地路径与索引不一致。');
    const dataOffset = offset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > centralOffset) fail('INVALID_PACKAGE', 'ZIP 数据越界。');
    inspectExtra(bytes, offset + 30 + localNameLength, localExtraLength);
    for (const [position, expected] of [[14, crc], [18, compressed], [22, size]]) {
      const actual = bytes.readUInt32LE(offset + position);
      if (flags & 8 ? actual !== 0 && actual !== expected : actual !== expected) fail('INVALID_PACKAGE', 'ZIP 本地大小或校验与索引不一致。');
    }
    spans.push([offset, dataOffset + compressed]); expanded += size;
    if (expanded > MAX_EXPANDED) fail('INVALID_PACKAGE', '解压后的更新包超过 2 GiB。');
    const mode = attributes >>> 16, kind = mode & 0xf000;
    if (kind && ![0x4000, 0x8000, 0xa000].includes(kind)) fail('UNSAFE_PACKAGE', 'ZIP 包含特殊设备文件。');
    const entry = { name, symlink: kind === 0xa000, directory: kind === 0x4000 || rawName.endsWith('/') };
    if (entry.symlink) {
      if (!name.startsWith(`${bundleName}/Contents/Frameworks/`) || size > 4096) fail('UNSAFE_PACKAGE', 'ZIP 包含不允许的符号链接。');
      const compressedBytes = bytes.subarray(dataOffset, dataOffset + compressed);
      let targetBytes;
      try { targetBytes = method === 0 ? compressedBytes : zlib.inflateRawSync(compressedBytes, { maxOutputLength: 4096 }); } catch { fail('INVALID_PACKAGE', 'ZIP 符号链接数据无效。'); }
      if (targetBytes.length !== size || crc32(targetBytes) !== crc) fail('INVALID_PACKAGE', 'ZIP 符号链接校验失败。');
      const target = targetBytes.toString('utf8');
      const framework = /^(.+?\.framework)(?:\/|$)/.exec(name)?.[1];
      if (!framework || !target || target.includes('\0') || target.includes('\\') || target.startsWith('/') || !Buffer.from(target).equals(targetBytes)) fail('UNSAFE_PACKAGE', 'ZIP 符号链接路径无效。');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      if (!(resolved === framework || resolved.startsWith(`${framework}/`))) fail('UNSAFE_PACKAGE', 'ZIP 符号链接逃逸应用框架。');
      entry.target = resolved;
    }
    entries.set(name, entry); cursor = next;
  }
  if (cursor !== end || !entries.has(`${bundleName}/Contents/Info.plist`)) fail('INVALID_PACKAGE', 'ZIP 缺少应用信息或索引损坏。');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail('INVALID_PACKAGE', 'ZIP 条目数据重叠。');
  for (const entry of entries.values()) {
    let ancestor = path.posix.dirname(entry.name);
    while (ancestor !== '.') { if (entries.get(ancestor)?.symlink) fail('UNSAFE_PACKAGE', 'ZIP 不能通过符号链接写入后续条目。'); ancestor = path.posix.dirname(ancestor); }
    if (entry.symlink) {
      let target = entry.target; const visited = new Set([entry.name]);
      for (let step = 0; step < 40; step++) {
        const parts = target.split('/');
        let alias = null;
        for (let index = 1; index <= parts.length; index++) {
          const prefix = parts.slice(0, index).join('/'), candidate = entries.get(prefix);
          if (candidate?.symlink) { alias = { prefix, entry: candidate, suffix: parts.slice(index).join('/') }; break; }
        }
        if (!alias) { if (!entries.has(target)) fail('UNSAFE_PACKAGE', 'ZIP 符号链接目标不存在。'); break; }
        if (visited.has(alias.prefix)) fail('UNSAFE_PACKAGE', 'ZIP 符号链接形成循环。');
        visited.add(alias.prefix);
        target = path.posix.normalize(path.posix.join(alias.entry.target, alias.suffix));
        if (step === 39) fail('UNSAFE_PACKAGE', 'ZIP 符号链接层级过深。');
      }
    }
  }
  return { entries: count, expandedSize: expanded };
}

async function bundleInformation(appPath) {
  const app = await noLinks(appPath, 'directory');
  const infoFile = await readFile(path.join(app, 'Contents', 'Info.plist'), 1024 * 1024);
  let info;
  try { info = JSON.parse(infoFile.bytes.toString('utf8')); } catch {
    try { info = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoFile.path])).stdout); } catch { fail('INVALID_BUNDLE', '应用 Info.plist 无效。'); }
  }
  if (!info || typeof info.CFBundleExecutable !== 'string' || path.basename(info.CFBundleExecutable) !== info.CFBundleExecutable || !info.CFBundleExecutable || info.CFBundleExecutable.includes('\0')) fail('INVALID_BUNDLE', '应用可执行文件名称无效。');
  const executable = await readFile(path.join(app, 'Contents', 'MacOS', info.CFBundleExecutable));
  if (executable.bytes.length < 32 || executable.bytes.readUInt32LE(0) !== 0xfeedfacf || executable.bytes.readUInt32LE(4) !== 0x0100000c || !(executable.stat.mode & 0o111)) fail('WRONG_ARCH', '更新包必须包含可执行的 arm64 Mac 应用。');
  return { app, version: info.CFBundleShortVersionString, bundleId: info.CFBundleIdentifier, executable: info.CFBundleExecutable };
}
async function treeDigest(appPath) {
  const app = await noLinks(appPath, 'directory');
  const digest = crypto.createHash('sha256');
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, entry), relative = path.relative(app, absolute).split(path.sep).join('/'), stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const framework = /^Contents\/Frameworks\/(.+?\.framework)(?:\/|$)/.exec(relative)?.[1];
        const target = await fs.readlink(absolute), real = await fs.realpath(absolute).catch(() => fail('UNSAFE_PACKAGE', '应用框架链接无法解析。'));
        const boundary = framework && path.join(app, 'Contents', 'Frameworks', framework);
        if (!boundary || path.isAbsolute(target) || target.includes('\\') || !(real === boundary || real.startsWith(`${boundary}${path.sep}`))) fail('UNSAFE_PACKAGE', '应用包包含越界符号链接。');
        digest.update(`L\0${relative}\0${target}\0`);
      } else if (stat.isDirectory()) { digest.update(`D\0${relative}\0${stat.mode & 0o777}\0`); await visit(absolute); }
      else if (stat.isFile() && stat.nlink === 1) { const file = await readFile(absolute); digest.update(`F\0${relative}\0${stat.mode & 0o777}\0${hash(file.bytes)}\0`); }
      else fail('UNSAFE_PACKAGE', '应用包含特殊文件或外部硬链接。');
    }
  }
  await visit(app); return digest.digest('hex');
}
async function verifyMacApp(appPath) {
  try { await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]); } catch (error) { throw new UpdateInstallError('INVALID_SIGNATURE', '更新应用的代码签名完整性验证失败。', error); }
  const display = await execute('/usr/bin/codesign', ['--display', '--verbose=4', appPath]);
  const team = /^TeamIdentifier=(.+)$/m.exec(`${display.stdout}\n${display.stderr}`)?.[1].trim();
  const teamIdentifier = team && team !== 'not set' ? team : null;
  try { await execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath]); return { signatureValid: true, gatekeeperAllowed: true, teamIdentifier }; }
  catch { return { signatureValid: true, gatekeeperAllowed: false, teamIdentifier }; }
}
async function checkBundle(appPath, expected, verifier) {
  const info = await bundleInformation(appPath);
  if (info.bundleId !== expected.bundleId) fail('WRONG_BUNDLE', '更新包的 Bundle ID 与当前应用不一致。');
  if (info.version !== expected.version) fail('VERSION_MISMATCH', '更新包内部版本与更新清单不一致。');
  if (expected.arch !== 'arm64') fail('WRONG_ARCH', '这台 Mac 仅接受当前 arm64 更新包。');
  const result = await verifier(info.app);
  if (!result || result.signatureValid !== true) fail('INVALID_SIGNATURE', '更新应用签名完整性验证失败。');
  if (result.teamIdentifier !== undefined && result.teamIdentifier !== null && !/^[A-Z0-9]{10}$/.test(result.teamIdentifier)) fail('INVALID_SIGNATURE', '应用发布者 Team ID 无效。');
  return { ...info, gatekeeperAllowed: result.gatekeeperAllowed === true, teamIdentifier: result.teamIdentifier || null, digest: await treeDigest(info.app) };
}
function testHooksFor(target, hooks) {
  if (!hooks) return {};
  const temporary = path.resolve(os.tmpdir());
  if (!process.env.NODE_TEST_CONTEXT || !(target.startsWith(`${temporary}${path.sep}`) || target.startsWith(`/private${temporary}${path.sep}`))) fail('TEST_HOOKS_FORBIDDEN', '测试注入只允许 Node 测试进程中的临时应用。');
  return hooks;
}
async function readPlan(planPath) {
  const file = await noLinks(planPath, 'file'), owned = await ownedRoot(path.dirname(file));
  if (path.basename(file) !== 'plan.json') fail('INVALID_PLAN', '更新计划文件名无效。');
  const { bytes, stat } = await readFile(file, 1024 * 1024);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) fail('UNSAFE_PATH', '更新计划文件权限无效。');
  let plan;
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_PLAN', '更新计划无法读取。'); }
  if (!plan || plan.schemaVersion !== 1 || plan.nonce !== owned.nonce || plan.stageRoot !== owned.root || plan.arch !== 'arm64' || !HASH.test(plan.zipSha256 || '') || !HASH.test(plan.targetDigest || '') || !HASH.test(plan.stagedDigest || '') || typeof plan.bundleId !== 'string' || typeof plan.targetAppPath !== 'string' || path.dirname(plan.targetAppPath) !== path.dirname(owned.root) || !path.basename(plan.targetAppPath).endsWith('.app') || plan.stagedAppPath !== path.join(owned.root, 'extracted', path.basename(plan.targetAppPath)) || plan.zipPath !== path.join(owned.root, 'release.zip') || plan.backupPath !== path.join(owned.root, 'previous.app') || !plan.targetIdentity || !Number.isSafeInteger(plan.targetIdentity.dev) || !Number.isSafeInteger(plan.targetIdentity.ino) || !plan.stagedIdentity || !Number.isSafeInteger(plan.stagedIdentity.dev) || !Number.isSafeInteger(plan.stagedIdentity.ino)) fail('INVALID_PLAN', '更新计划的路径或身份信息无效。');
  if (compareVersions(plan.targetVersion, plan.currentVersion) <= 0) fail('INVALID_VERSION', '更新计划不是更高版本。');
  return { plan, path: file, root: owned.root };
}
async function readState(root) {
  try { return JSON.parse((await readFile(path.join(root, 'state.json'), 1024 * 1024)).bytes.toString('utf8')); } catch { fail('INVALID_PLAN', '更新状态无法读取。'); }
}
async function revalidate(plan, hooks, requireTarget = true, signal) {
  checkAbort(signal);
  const zip = await readFile(plan.zipPath);
  checkAbort(signal);
  if (hash(zip.bytes) !== plan.zipSha256) fail('CHECKSUM_MISMATCH', '暂存更新包校验失败。');
  inspectZip(zip.bytes, path.basename(plan.targetAppPath));
  const staged = await checkBundle(plan.stagedAppPath, { bundleId: plan.bundleId, version: plan.targetVersion, arch: plan.arch }, hooks.verifier || verifyMacApp);
  checkAbort(signal);
  if (staged.digest !== plan.stagedDigest) fail('CONFLICT', '暂存应用被修改，更新已停止。');
  if (staged.teamIdentifier !== plan.candidateTeamIdentifier || plan.currentTeamIdentifier && staged.teamIdentifier !== plan.currentTeamIdentifier) fail('WRONG_SIGNER', '更新发布者与当前应用的正式签名身份不同。');
  if (!staged.gatekeeperAllowed) fail('GATEKEEPER_REJECTED', 'macOS Gatekeeper 拒绝此更新，应用没有被替换。');
  if (requireTarget) {
    const target = await noLinks(plan.targetAppPath, 'directory'), stat = await fs.lstat(target);
    checkAbort(signal);
    if (!sameIdentity(stat, plan.targetIdentity)) fail('CONFLICT', '当前应用已被替换，更新没有覆盖它。');
    const current = await bundleInformation(target);
    checkAbort(signal);
    const currentDigest = await treeDigest(target);
    checkAbort(signal);
    if (current.version !== plan.currentVersion || current.bundleId !== plan.bundleId || currentDigest !== plan.targetDigest) fail('CONFLICT', '当前应用内容或版本发生变化，请重新检查更新。');
    const currentSignature = await (hooks.verifier || verifyMacApp)(target);
    checkAbort(signal);
    if (currentSignature.signatureValid !== true || (currentSignature.teamIdentifier || null) !== plan.currentTeamIdentifier) fail('WRONG_SIGNER', '当前应用的签名发布者身份发生变化。');
  }
}

class LocalUpdateInstaller {
  constructor({ targetAppPath, currentVersion, bundleId, arch = 'arm64', testHooks } = {}) {
    if (typeof targetAppPath !== 'string' || !path.isAbsolute(targetAppPath) || !path.basename(targetAppPath).endsWith('.app') || path.dirname(targetAppPath).split(path.sep).some(part => part.endsWith('.app'))) fail('INVALID_TARGET', '更新目标必须是当前已打包的普通 Mac 应用。');
    version(currentVersion);
    if (typeof bundleId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId) || arch !== 'arm64') fail('INVALID_TARGET', '当前应用身份或架构无效。');
    this.targetAppPath = path.resolve(targetAppPath); this.currentVersion = currentVersion; this.bundleId = bundleId; this.arch = arch;
    this.hooks = testHooksFor(this.targetAppPath, testHooks);
    this.plans = new Map(); this.handoffBusy = false;
  }

  async prepare({ zipPath, sha256, targetVersion, currentVersion = this.currentVersion, bundleId = this.bundleId, arch = this.arch } = {}) {
    if (currentVersion !== this.currentVersion || bundleId !== this.bundleId || arch !== this.arch) fail('VERSION_MISMATCH', '更新清单与当前应用身份不匹配。');
    if (compareVersions(targetVersion, this.currentVersion) <= 0) fail('NOT_NEWER', '更新版本必须高于当前版本。');
    if (!HASH.test(sha256 || '')) fail('CHECKSUM_MISMATCH', '更新清单缺少有效 SHA-256。');
    const target = await noLinks(this.targetAppPath, 'directory'), targetStat = await fs.lstat(target);
    const parent = await noLinks(path.dirname(target), 'directory');
    const current = await bundleInformation(target);
    if (current.version !== this.currentVersion || current.bundleId !== this.bundleId) fail('CONFLICT', '当前应用版本或身份已改变，请重新检查更新。');
    const currentSignature = await (this.hooks.verifier || verifyMacApp)(target);
    if (currentSignature.signatureValid !== true || currentSignature.teamIdentifier !== undefined && currentSignature.teamIdentifier !== null && !/^[A-Z0-9]{10}$/.test(currentSignature.teamIdentifier)) fail('INVALID_SIGNATURE', '当前应用的签名完整性或发布者身份无效。');
    try { await fs.access(parent, constants.W_OK | constants.X_OK); } catch (error) { throw new UpdateInstallError('READ_ONLY', '当前应用位于只读或不可写目录，请先安装到可写位置。', error); }
    const archive = await readFile(zipPath);
    if (hash(archive.bytes) !== sha256) fail('CHECKSUM_MISMATCH', '更新 ZIP 的 SHA-256 与清单不一致。');
    inspectZip(archive.bytes, path.basename(target));
    const nonce = crypto.randomUUID(), stageRoot = path.join(parent, `${PREFIX}${nonce}`);
    try { await fs.mkdir(stageRoot, { mode: 0o700 }); await syncDirectory(parent); } catch (error) { throw new UpdateInstallError('READ_ONLY', '无法在当前应用旁创建更新暂存目录。', error); }
    try {
      await writeNew(path.join(stageRoot, 'release.zip'), archive.bytes);
      const extracted = path.join(stageRoot, 'extracted'); await fs.mkdir(extracted, { mode: 0o700 }); await syncDirectory(stageRoot);
      if (this.hooks.extractor) await this.hooks.extractor(path.join(stageRoot, 'release.zip'), extracted);
      else await execute('/usr/bin/ditto', ['-x', '-k', path.join(stageRoot, 'release.zip'), extracted]);
      const stagedAppPath = path.join(extracted, path.basename(target));
      // Preserve source quarantine instead of stripping it during extraction.
      if (!this.hooks.skipQuarantineRead) {
        let quarantine;
        try { quarantine = (await execute('/usr/bin/xattr', ['-p', 'com.apple.quarantine', archive.path])).stdout.trim(); } catch (error) { if (error.code !== 1) throw error; }
        if (quarantine) await execute('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, stagedAppPath]);
      }
      const verified = await checkBundle(stagedAppPath, { bundleId, version: targetVersion, arch }, this.hooks.verifier || verifyMacApp);
      const currentTeamIdentifier = currentSignature.teamIdentifier || null;
      if (currentTeamIdentifier && verified.teamIdentifier !== currentTeamIdentifier) fail('WRONG_SIGNER', '更新包的正式签名发布者与当前应用不同，更新已停止。');
      const plan = { schemaVersion: 1, nonce, stageRoot, targetAppPath: target, currentVersion, targetVersion, bundleId, arch, zipPath: path.join(stageRoot, 'release.zip'), zipSha256: sha256, stagedAppPath, stagedDigest: verified.digest, stagedIdentity: identity(await fs.lstat(stagedAppPath)), targetDigest: await treeDigest(target), targetIdentity: identity(targetStat), currentTeamIdentifier, candidateTeamIdentifier: verified.teamIdentifier, backupPath: path.join(stageRoot, 'previous.app'), createdAt: new Date().toISOString(), canInstall: verified.gatekeeperAllowed };
      const planPath = path.join(stageRoot, 'plan.json');
      await writeNew(planPath, json(plan));
      await writeNew(path.join(stageRoot, 'install-helper.cjs'), await fs.readFile(__filename));
      const reasons = verified.gatekeeperAllowed ? [] : [{ code: 'GATEKEEPER_REJECTED', message: 'macOS Gatekeeper 拒绝此包。签名完整性已验证，但无法自动安装；没有移除隔离属性或修改系统安全设置。' }];
      if (!currentTeamIdentifier) reasons.push({ code: 'NEW_SIGNER_UNCONFIRMED', message: '当前应用没有正式 Team ID，无法独立认证更新发布者；同源 SHA-256 只验证文件完整性。' });
      await writeState(stageRoot, { nonce, status: verified.gatekeeperAllowed ? 'prepared' : 'blocked', currentVersion, targetVersion, reasons, updatedAt: new Date().toISOString() });
      this.plans.set(planPath, { targetAppPath: target, currentVersion, targetVersion, nonce, planHash: hash(Buffer.from(json(plan))) });
      return { verified: true, canInstall: verified.gatekeeperAllowed, reasons, planPath, stageRoot, currentVersion, targetVersion, bundleId, arch, publisherAuthenticated: Boolean(currentTeamIdentifier) };
    } catch (error) { await removeOwnedStage(stageRoot).catch(() => {}); throw error; }
  }

  async handoff({ planPath, parentPid = process.pid, confirmed = false, signal } = {}) {
    if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('INVALID_PLAN', '更新取消信号无效。');
    checkAbort(signal);
    if (confirmed !== true) fail('CONFIRMATION_REQUIRED', '请确认后再退出应用并安装更新。');
    if (this.handoffBusy) fail('UPDATE_BUSY', '更新已经在准备交接，请勿重复点击。');
    if (!this.plans.has(planPath)) fail('INVALID_PLAN', '更新计划不是本次检查创建的计划。');
    this.handoffBusy = true;
    let root, plan, previousState, waitingWritten = false, child, cancelTask;
    const restorePrepared = async () => {
      if (!root || !waitingWritten) return;
      const current = await readState(root);
      if (current.nonce === plan.nonce && current.status === 'waiting-for-exit' && current.parentPid === parentPid) {
        await writeState(root, { ...previousState, updatedAt: new Date().toISOString() });
        waitingWritten = false;
      }
    };
    const cancelOwnedHandoff = () => {
      if (!cancelTask) {
        // The child is the ChildProcess created below, never a renderer PID.
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        cancelTask = (async () => { await restorePrepared(); if (child) await stopOwnedHelper(child); })();
        cancelTask.catch(() => {});
      }
      return cancelTask;
    };
    const onAbort = () => { cancelOwnedHandoff(); };
    const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
    try {
      ({ plan, root } = await readPlan(planPath)); checkAbort(signal);
      const expectedPlan = this.plans.get(planPath), planBytes = await readFile(planPath, 1024 * 1024); checkAbort(signal);
      if (plan.targetAppPath !== expectedPlan.targetAppPath || plan.currentVersion !== expectedPlan.currentVersion || plan.targetVersion !== expectedPlan.targetVersion || plan.nonce !== expectedPlan.nonce || hash(planBytes.bytes) !== expectedPlan.planHash) fail('CONFLICT', '更新计划被修改，请重新检查更新。');
      previousState = await readState(root); checkAbort(signal);
      if (!plan.canInstall || previousState.status !== 'prepared') fail('GATEKEEPER_REJECTED', '此更新没有通过 macOS 安全策略，不会退出或替换应用。');
      await revalidate(plan, this.hooks, true, signal); checkAbort(signal);
      if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid !== process.pid) fail('INVALID_PLAN', '更新只能等待当前应用进程退出。');
      await writeState(root, { nonce: plan.nonce, status: 'waiting-for-exit', parentPid, currentVersion: plan.currentVersion, targetVersion: plan.targetVersion, updatedAt: new Date().toISOString() });
      waitingWritten = true;
      if (this.hooks.handoffCheckpoint) await this.hooks.handoffCheckpoint('after-state-write');
      checkAbort(signal);
      if (this.hooks.handoff) {
        const result = await this.hooks.handoff({ planPath, parentPid, statePath: path.join(root, 'state.json'), signal });
        if (signal?.aborted) { await result?.cancel?.(); checkAbort(signal); }
        return result;
      }
      const log = await fs.open(path.join(root, `helper-${crypto.randomUUID()}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        checkAbort(signal);
        signal?.addEventListener('abort', onAbort, { once: true });
        checkAbort(signal);
        child = (this.hooks.spawnHelper || spawn)(process.execPath, [path.join(root, 'install-helper.cjs'), '--install-plan', planPath, '--parent-pid', String(parentPid)], { detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', log.fd, log.fd] });
        child.once('exit', removeAbortListener);
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        checkAbort(signal); child.unref();
      } finally { await log.close(); }
      checkAbort(signal);
      // Keep the abort listener until the owned child exits. The adapter must
      // also test this same signal immediately before its delayed app.quit().
      return { started: true, planPath, statePath: path.join(root, 'state.json') };
    } catch (error) {
      if (signal?.aborted || error.code === 'ABORTED') {
        await cancelOwnedHandoff(); removeAbortListener(); checkAbort(signal);
      }
      if (child) await stopOwnedHelper(child);
      await restorePrepared(); removeAbortListener(); throw error;
    } finally { this.handoffBusy = false; }
  }

  async disposePlan(planPath) {
    if (!this.plans.has(planPath)) fail('INVALID_PLAN', '更新计划不是当前应用拥有的计划。');
    const { root } = await readPlan(planPath), state = await readState(root);
    if (!['prepared', 'blocked'].includes(state.status)) fail('UPDATE_BUSY', '已经交接的更新保留备份和状态，不能清理。');
    await removeOwnedStage(root); this.plans.delete(planPath);
    return { disposed: true };
  }
}

async function removeOwnedStage(root) {
  const owned = await ownedRoot(root);
  // Unlink symlinks as entries without following them; only this private stage is removed.
  await fs.rm(owned.root, { recursive: true, force: false }); await syncDirectory(path.dirname(root));
}
async function stopOwnedHelper(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) return;
  let exited = false;
  const onExit = () => { exited = true; };
  child.once('exit', onExit); child.kill('SIGTERM');
  try {
    const end = Date.now() + 1500;
    while (!exited && child.exitCode === null && child.signalCode === null && Date.now() < end) await pause(20);
    if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const killedEnd = Date.now() + 1500;
    while (!exited && child.exitCode === null && child.signalCode === null && Date.now() < killedEnd) await pause(20);
    if (!exited && child.exitCode === null && child.signalCode === null) fail('ABORT_CLEANUP_FAILED', '更新辅助进程没有确认退出；原应用未退出，暂存状态已保留。');
  } finally { child.removeListener('exit', onExit); }
}
async function waitForExit(pid, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await pause(100);
  }
  fail('EXIT_TIMEOUT', '原应用未退出，更新没有替换应用。');
}
async function launchMacApp(app, planPath) {
  const args = ['-n', app];
  if (planPath) args.push('--args', `${ACK_ARGUMENT}${planPath}`);
  await execute('/usr/bin/open', args);
}
async function waitForAcknowledgment(root, plan, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const file = await readFile(path.join(root, 'confirmation.json'), 16384), confirmation = JSON.parse(file.bytes.toString('utf8'));
      if (file.stat.uid !== process.getuid?.() || confirmation.nonce !== plan.nonce || confirmation.version !== plan.targetVersion || confirmation.bundleId !== plan.bundleId || confirmation.appPath !== plan.targetAppPath || !Number.isSafeInteger(confirmation.pid) || confirmation.pid < 1) fail('INVALID_ACK', '新应用启动确认无效。');
      return confirmation;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(50);
  }
  fail('STARTUP_TIMEOUT', '新应用没有确认界面启动，正在恢复上一版本。');
}
async function runInstallPlan(planPath, { parentPid, testHooks } = {}) {
  const { plan, root } = await readPlan(planPath), hooks = testHooksFor(plan.targetAppPath, testHooks);
  const state = await readState(root);
  if (['replacing', 'awaiting-confirmation', 'rollback-failed', 'rollback-blocked'].includes(state.status)) return recoverInstallPlan(planPath, { testHooks });
  if (state.status !== 'waiting-for-exit' || state.nonce !== plan.nonce || !plan.canInstall || !Number.isSafeInteger(parentPid) || parentPid < 1 || state.parentPid !== parentPid) fail('INVALID_PLAN', '更新计划未获得确认或已经运行。');
  const stateFor = (status, extra = {}) => ({ nonce: plan.nonce, status, parentPid, currentVersion: plan.currentVersion, targetVersion: plan.targetVersion, updatedAt: new Date().toISOString(), ...extra });
  let backedUp = false, installed = false, launched = false;
  try {
    await (hooks.waitForExit || waitForExit)(parentPid);
    const latestState = await readState(root);
    if (latestState.nonce !== plan.nonce || latestState.status !== 'waiting-for-exit' || latestState.parentPid !== parentPid) fail('ABORTED', '更新交接已取消，辅助进程没有替换应用。');
    await revalidate(plan, hooks);
    await writeState(root, stateFor('replacing'));
    await fs.rename(await noLinks(plan.targetAppPath, 'directory'), plan.backupPath); backedUp = true;
    await syncDirectory(path.dirname(plan.targetAppPath)); await syncDirectory(root);
    await writeState(root, stateFor('replacing', { step: 'backed-up' }));
    if (hooks.fault) await hooks.fault('after-backup');
    await fs.rename(await noLinks(plan.stagedAppPath, 'directory'), plan.targetAppPath); installed = true;
    await syncDirectory(path.dirname(plan.targetAppPath)); await syncDirectory(path.dirname(plan.stagedAppPath));
    await writeState(root, stateFor('replacing', { step: 'installed' }));
    if (hooks.fault) await hooks.fault('after-replace');
    await writeState(root, stateFor('awaiting-confirmation'));
    await (hooks.launcher || launchMacApp)(plan.targetAppPath, planPath);
    launched = true;
    const confirmation = await waitForAcknowledgment(root, plan, hooks.confirmationTimeoutMs || 20000);
    await writeState(root, stateFor('completed', { confirmation, backupPath: plan.backupPath }));
    return { installed: true, version: plan.targetVersion, backupPath: plan.backupPath, statePath: path.join(root, 'state.json') };
  } catch (error) {
    if (error.crash) throw error;
    try {
      if (launched) await stopUnconfirmedLaunch(root, plan, hooks);
      if (installed) {
        if (!sameIdentity(await fs.lstat(await noLinks(plan.targetAppPath, 'directory')), plan.stagedIdentity) || await treeDigest(plan.targetAppPath) !== plan.stagedDigest) fail('ROLLBACK_CONFLICT', '新应用被外部修改，回滚没有覆盖它。');
        await fs.rename(plan.targetAppPath, path.join(root, 'failed-new.app'));
      }
      if (backedUp) {
        if (await treeDigest(plan.backupPath) !== plan.targetDigest) fail('ROLLBACK_CONFLICT', '旧应用备份被修改，回滚已经停止。');
        const targetExists = await fs.lstat(plan.targetAppPath).then(() => true).catch(probe => { if (probe.code === 'ENOENT') return false; throw probe; });
        if (targetExists) fail('ROLLBACK_CONFLICT', '应用路径出现外部文件，旧版本没有覆盖它。');
        await fs.rename(plan.backupPath, plan.targetAppPath); await syncDirectory(path.dirname(plan.targetAppPath)); await syncDirectory(root);
        await (hooks.launcher || launchMacApp)(plan.targetAppPath, null);
      }
      await writeState(root, stateFor(backedUp ? 'rolled-back' : 'failed', { error: { code: error.code || 'INSTALL_FAILED', message: error.message } }));
    } catch (rollbackError) {
      await writeState(root, stateFor(rollbackError.code === 'ROLLBACK_BLOCKED' ? 'rollback-blocked' : 'rollback-failed', { error: { code: rollbackError.code || 'ROLLBACK_FAILED', message: rollbackError.message } })).catch(() => {});
      throw new UpdateInstallError('ROLLBACK_FAILED', '更新失败且恢复遇到问题；旧应用备份与更新状态已保留。', rollbackError);
    }
    throw error;
  }
}
async function launchDetails({ argv = [], appPath, version: runningVersion } = {}) {
  const argumentsFound = argv.filter(value => typeof value === 'string' && value.startsWith(ACK_ARGUMENT));
  if (!argumentsFound.length) return null;
  if (argumentsFound.length !== 1) fail('INVALID_ACK', '更新启动确认参数重复。');
  const { plan, root } = await readPlan(argumentsFound[0].slice(ACK_ARGUMENT.length));
  const app = await noLinks(appPath, 'directory'), info = await bundleInformation(app), state = await readState(root);
  if (app !== plan.targetAppPath || runningVersion !== plan.targetVersion || info.version !== plan.targetVersion || info.bundleId !== plan.bundleId || state.status !== 'awaiting-confirmation' || state.nonce !== plan.nonce || await treeDigest(app) !== plan.stagedDigest) fail('INVALID_ACK', '启动应用与已确认的更新计划不一致。');
  return { plan, root, info, runningVersion };
}

async function registerLaunch(options) {
  const details = await launchDetails(options);
  if (!details) return { registered: false };
  const { plan, root, info, runningVersion } = details;
  const registration = { nonce: plan.nonce, version: runningVersion, bundleId: plan.bundleId, appPath: plan.targetAppPath, executablePath: path.join(plan.targetAppPath, 'Contents', 'MacOS', info.executable), pid: process.pid, processStartedAt: Date.now() - process.uptime() * 1000, recordedAt: new Date().toISOString() };
  await writeNew(path.join(root, 'startup.json'), json(registration));
  return { registered: true, version: runningVersion };
}
async function acknowledgeLaunch(options) {
  const details = await launchDetails(options);
  if (!details) return { acknowledged: false };
  const { plan, root, runningVersion } = details;
  const startup = await readStartup(root, plan);
  if (startup.pid !== process.pid) fail('INVALID_ACK', '界面启动确认来自不同进程。');
  const confirmation = { nonce: plan.nonce, version: runningVersion, bundleId: plan.bundleId, appPath: plan.targetAppPath, pid: process.pid, confirmedAt: new Date().toISOString() };
  try { await writeNew(path.join(root, 'confirmation.json'), json(confirmation)); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse((await readFile(path.join(root, 'confirmation.json'), 16384)).bytes.toString('utf8'));
    if (previous.nonce !== plan.nonce || previous.pid !== process.pid || previous.version !== runningVersion) fail('INVALID_ACK', '已有启动确认不匹配。');
  }
  return { acknowledged: true, version: runningVersion };
}
async function readStartup(root, plan) {
  let registration, file;
  try { file = await readFile(path.join(root, 'startup.json'), 16384); registration = JSON.parse(file.bytes.toString('utf8')); } catch { fail('ROLLBACK_BLOCKED', '无法证明未确认的新应用进程身份；旧应用备份已保留，未启动第二实例。'); }
  const info = await bundleInformation(plan.targetAppPath);
  if (file.stat.uid !== process.getuid?.() || file.stat.mode & 0o077 || registration.nonce !== plan.nonce || registration.version !== plan.targetVersion || registration.bundleId !== plan.bundleId || registration.appPath !== plan.targetAppPath || registration.executablePath !== path.join(plan.targetAppPath, 'Contents', 'MacOS', info.executable) || !Number.isSafeInteger(registration.pid) || registration.pid < 1 || !Number.isFinite(registration.processStartedAt)) fail('ROLLBACK_BLOCKED', '新应用启动记录无效，旧应用备份已保留。');
  return registration;
}
async function stopUnconfirmedLaunch(root, plan, hooks) {
  const registration = await readStartup(root, plan);
  if (hooks.stopUnconfirmed) return hooks.stopUnconfirmed(registration);
  if (registration.pid === process.pid) fail('ROLLBACK_BLOCKED', '启动记录指向更新辅助进程，恢复已经停止。');
  async function proveAlive() {
    try { process.kill(registration.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    let command, started;
    try {
      command = (await execute('/bin/ps', ['-p', String(registration.pid), '-o', 'comm='])).stdout.trim();
      started = Date.parse((await execute('/bin/ps', ['-p', String(registration.pid), '-o', 'lstart='])).stdout.trim());
    } catch { fail('ROLLBACK_BLOCKED', '不能核对新应用的系统进程身份，未停止其他进程。'); }
    if (command !== registration.executablePath || !Number.isFinite(started) || Math.abs(started - registration.processStartedAt) > 5000) fail('ROLLBACK_BLOCKED', '新应用 PID 已变化或无法核实，未停止其他进程。');
    return true;
  }
  if (!await proveAlive()) return;
  process.kill(registration.pid, 'SIGTERM');
  const end = Date.now() + 1500;
  while (Date.now() < end) { if (!await proveAlive()) return; await pause(50); }
  if (await proveAlive()) process.kill(registration.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 40; attempt++) { if (!await proveAlive()) return; await pause(50); }
  fail('ROLLBACK_BLOCKED', '新应用未退出；旧应用备份已保留，未同时启动旧版本。');
}
async function recoverInstallPlan(planPath, { testHooks } = {}) {
  const { plan, root } = await readPlan(planPath), hooks = testHooksFor(plan.targetAppPath, testHooks), state = await readState(root);
  if (state.nonce !== plan.nonce || !['replacing', 'awaiting-confirmation', 'rollback-failed', 'rollback-blocked'].includes(state.status)) fail('INVALID_PLAN', '此更新状态不需要事务恢复。');
  if (!Number.isSafeInteger(state.parentPid) || state.parentPid < 1) fail('INVALID_PLAN', '恢复状态缺少原应用进程记录。');
  await (hooks.waitForExit || waitForExit)(state.parentPid);
  const stateFor = (status, extra = {}) => ({ nonce: plan.nonce, status, parentPid: state.parentPid, currentVersion: plan.currentVersion, targetVersion: plan.targetVersion, updatedAt: new Date().toISOString(), ...extra });
  try {
    const target = await fs.lstat(plan.targetAppPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (target) {
      await noLinks(plan.targetAppPath, 'directory');
      const digest = await treeDigest(plan.targetAppPath);
      if (sameIdentity(target, plan.targetIdentity) && digest === plan.targetDigest) {
        await writeState(root, stateFor('rolled-back', { recovered: true })); return { recovered: true, rolledBack: true };
      }
      if (!sameIdentity(target, plan.stagedIdentity) || digest !== plan.stagedDigest) fail('ROLLBACK_CONFLICT', '应用路径有外部变化，恢复没有覆盖它。');
      const confirmationExists = await fs.lstat(path.join(root, 'confirmation.json')).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      if (confirmationExists) {
        const confirmation = await waitForAcknowledgment(root, plan, 100);
        await writeState(root, stateFor('completed', { recovered: true, confirmation, backupPath: plan.backupPath }));
        return { recovered: true, installed: true, version: plan.targetVersion };
      }
      if (state.status === 'awaiting-confirmation' || state.status === 'rollback-blocked') await stopUnconfirmedLaunch(root, plan, hooks);
    }
    const backup = await noLinks(plan.backupPath, 'directory'), backupStat = await fs.lstat(backup);
    if (!sameIdentity(backupStat, plan.targetIdentity) || await treeDigest(backup) !== plan.targetDigest) fail('ROLLBACK_CONFLICT', '旧应用备份校验失败，恢复已经停止。');
    if (target) await fs.rename(plan.targetAppPath, path.join(root, 'failed-new.app'));
    await fs.rename(backup, plan.targetAppPath); await syncDirectory(path.dirname(plan.targetAppPath)); await syncDirectory(root);
    await (hooks.launcher || launchMacApp)(plan.targetAppPath, null);
    await writeState(root, stateFor('rolled-back', { recovered: true }));
    return { recovered: true, rolledBack: true, statePath: path.join(root, 'state.json') };
  } catch (error) { await writeState(root, stateFor(error.code === 'ROLLBACK_BLOCKED' ? 'rollback-blocked' : 'rollback-failed', { error: { code: error.code || 'RECOVERY_FAILED', message: error.message } })).catch(() => {}); throw error; }
}

module.exports = { LocalUpdateInstaller, UpdateInstallError, compareVersions, runInstallPlan, recoverInstallPlan, registerLaunch, acknowledgeLaunch };

if (require.main === module) {
  const args = process.argv.slice(2);
  const planIndex = args.indexOf('--install-plan'), pidIndex = args.indexOf('--parent-pid');
  const recoveryIndex = args.indexOf('--recover-plan');
  if (recoveryIndex >= 0) recoverInstallPlan(args[recoveryIndex + 1]).catch(error => { process.stderr.write(`${error.code || 'RECOVERY_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
  else if (planIndex < 0 || pidIndex < 0) process.exitCode = 2;
  else runInstallPlan(args[planIndex + 1], { parentPid: Number(args[pidIndex + 1]) }).catch(error => { process.stderr.write(`${error.code || 'INSTALL_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
}
