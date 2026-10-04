'use strict';

// Main-process, read-only planning. Files are copied only by the separate local
// library transaction after this private plan has been revalidated.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CAPS = Object.freeze({ records: 500, entries: 5000, manifest: 32 * 1024 * 1024,
  image: 30 * 1024 * 1024, totalImages: 1024 * 1024 * 1024, prompt: 65536, metadataDepth: 24,
  directoryDepth: 3, manifests: 32, totalManifestBytes: 64 * 1024 * 1024 });
const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;
const trust = new WeakMap();
const discoveryTrust = new WeakMap();
const MESSAGES = {
  INVALID_SOURCE: '请选择包含图片与 JSON 提示词清单的真实本地文件夹。',
  UNSAFE_PATH: '来源路径不能越界或包含符号链接。',
  SOURCE_CHANGED: '导入来源发生变化，请重新预览。',
  READ_FAILED: '无法读取导入来源，请检查文件权限。',
  INVALID_MANIFEST: '导入文档必须是有效 UTF-8 JSON 记录数组或包含 images 数组的对象。',
  MANIFEST_TOO_LARGE: '导入文档超过允许大小或记录数量。',
  DIRECTORY_TOO_LARGE: '来源文件夹及子目录中的条目数量超过允许范围。',
  DIRECTORY_TOO_DEEP: '导入文件夹超过允许的 3 层子目录，请将清单和图片移到较浅的目录。',
  TOO_MANY_MANIFESTS: '导入文件夹中的 JSON 文件超过 32 个，请选择更具体的文件夹。',
  MANIFEST_TOTAL_TOO_LARGE: '导入文件夹中的 JSON 文档总大小超过 64 MiB。',
  NO_MANIFEST: '所选文件夹内未找到 JSON 清单，请将图片和清单放在同一文件夹下。',
  MANIFEST_SELECTION_REQUIRED: '找到多个 JSON 记录清单，请选择要导入的一份。',
  INVALID_DISCOVERY: '文件夹扫描已失效，请重新选择导入文件夹。',
  INVALID_TRANSLATION: '衍生中文翻译必须完整对应唯一的来源编号，且不能覆盖来源已有中文或无效提示词。',
  BATCH_TOO_LARGE: '本次配对图片总大小超过 1 GiB。',
  INVALID_PLAN: '导入预览已失效，请重新选择来源。',
  INVALID_TYPE: '批量导入类型必须是摄影或绘画。',
  IMAGE_TOO_LARGE: '图片超过允许的 30 MiB 大小。'
};

class BatchImportError extends Error {
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.READ_FAILED); this.name = 'BatchImportError'; this.code = code in MESSAGES ? code : 'READ_FAILED'; }
}
const fail = code => { throw new BatchImportError(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const filePin = stat => ({ ...identity(stat), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function currentStat(filename) {
  try { return await fs.lstat(filename); } catch { fail('SOURCE_CHANGED'); }
}

function deepFreeze(value, depth = 0) {
  if (depth > CAPS.metadataDepth) fail('INVALID_MANIFEST');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}

async function absolutePins(filename, expectedType) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 4096
    || /[\u0000-\u001f\u007f\\]/.test(filename) || filename.split(path.sep).some(part => part === '..' || part === '.')) fail('INVALID_SOURCE');
  const absolute = path.resolve(filename);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  const pins = [];
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); } catch { fail('READ_FAILED'); }
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
    const last = index === parts.length - 1;
    const type = last ? expectedType : 'directory';
    if (type === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('INVALID_SOURCE');
    pins.push({ path: current, type, ...(type === 'file' ? filePin(stat) : identity(stat)) });
  }
  if (!pins.length || await fs.realpath(absolute) !== absolute) fail('UNSAFE_PATH');
  return { absolute, pins };
}

async function assertPins(pins, includeFileVersion = false) {
  for (const pin of pins) {
    let stat;
    try { stat = await fs.lstat(pin.path); } catch { fail('SOURCE_CHANGED'); }
    if (stat.isSymbolicLink() || !sameIdentity(stat, pin)
      || (pin.type === 'directory' ? !stat.isDirectory() : !stat.isFile())
      || pin.type === 'file' && includeFileVersion && !sameFile(stat, pin)) fail('SOURCE_CHANGED');
  }
  if (await fs.realpath(pins.at(-1).path) !== pins.at(-1).path) fail('SOURCE_CHANGED');
}

async function boundedRead(filename, limit, ancestorPins, expectedPin, oversizedCode = 'READ_FAILED') {
  await assertPins(ancestorPins);
  let handle;
  try { handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { fail(error.code === 'ELOOP' ? 'UNSAFE_PATH' : 'READ_FAILED'); }
  try {
    await assertPins(ancestorPins);
    const before = await handle.stat();
    if (!before.isFile() || expectedPin && !sameFile(before, expectedPin)) fail('SOURCE_CHANGED');
    if (before.size > limit) fail(oversizedCode);
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(256 * 1024, limit + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) fail(oversizedCode);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await currentStat(filename);
    await assertPins(ancestorPins);
    if (current.isSymbolicLink() || !sameFile(before, after) || !sameFile(after, current)) fail('SOURCE_CHANGED');
    return { bytes: Buffer.concat(chunks), pin: filePin(after) };
  } finally { await handle.close(); }
}

async function entryNames(directory) {
  const result = [];
  const opened = await fs.opendir(directory);
  for await (const entry of opened) {
    result.push(entry.name);
    if (result.length > CAPS.entries) fail('DIRECTORY_TOO_LARGE');
  }
  return result.sort();
}

function idValue(value) {
  const id = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id >= 1 && id <= 999999 ? id : null;
}
function leadingId(filename) { const match = /^(\d{1,6})[-_]/.exec(filename); return match ? idValue(match[1]) : null; }
function imageName(record, allowRelative = false) {
  const fields = ['image', 'filename', 'fileName', 'image_file'].filter(field => Object.hasOwn(record, field));
  if (!fields.length) return { name: null };
  if (fields.some(field => typeof record[field] !== 'string') || new Set(fields.map(field => record[field])).size !== 1) return { error: 'INVALID_IMAGE_NAME' };
  const name = record[fields[0]];
  if (allowRelative ? !safeRelativePath(name) || !IMAGE_EXTENSION.test(name)
    : !name || name.length > 255 || /[\u0000-\u001f\u007f/\\:]/.test(name) || name === '.' || name === '..' || !IMAGE_EXTENSION.test(name)) return { error: 'INVALID_IMAGE_NAME' };
  return { name };
}

function imageMime(bytes) {
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width && height && width <= 50000 && height <= 50000 && width * height <= 100000000) return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
  return null;
}
function extensionMatches(name, mime) { return mime === 'image/png' ? /\.png$/i.test(name) : mime === 'image/jpeg' ? /\.jpe?g$/i.test(name) : /\.webp$/i.test(name); }

function promptField(record, candidates) {
  for (const field of candidates) {
    const value = field.includes('.') ? record.prompts?.[field.split('.')[1]] : record[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > CAPS.prompt || value.includes('\0')) return { value: '', origin: field, invalid: true };
    return { value, origin: field };
  }
  return { value: '', origin: null };
}

// Only trusted main-process callers can supply this option. The renderer's
// ordinary directory-import route does not forward translations or overwrite
// source prompts. Snapshot the complete mapping before any asynchronous decode.
function validateDerivedChinesePrompts(rows, idCounts, supplied) {
  if (supplied === undefined) return new Map();
  if (!isRecord(supplied) || ![Object.prototype, null].includes(Object.getPrototypeOf(supplied))
    || Object.getOwnPropertySymbols(supplied).length) fail('INVALID_TRANSLATION');
  if (rows.some(row => row.id === null || idCounts.get(row.id) !== 1)) fail('INVALID_TRANSLATION');
  const eligible = new Map();
  for (const row of rows) {
    const en = promptField(row.raw, ['prompt_en', 'prompt', 'prompts.en']);
    const zh = promptField(row.raw, ['prompt_cn', 'prompt_zh', 'prompts.zh']);
    if (en.value && !zh.value && !zh.invalid) eligible.set(row.id, row);
  }
  const descriptors = Object.getOwnPropertyDescriptors(supplied);
  if (Object.keys(descriptors).length !== eligible.size) fail('INVALID_TRANSLATION');
  const translations = new Map();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!/^[1-9]\d{0,5}$/.test(key) || !eligible.has(Number(key)) || !Object.hasOwn(descriptor, 'value')
      || !descriptor.enumerable || typeof descriptor.value !== 'string' || !descriptor.value.trim()
      || descriptor.value.length > CAPS.prompt || descriptor.value.includes('\0')) fail('INVALID_TRANSLATION');
    translations.set(Number(key), descriptor.value);
  }
  return translations;
}

// The generated-portraits exporter wraps its records in "images". Keep the
// entire original JSON byte stream; this only selects its indexed record array.
function extractManifestRecords(value) {
  if (Array.isArray(value)) return value;
  return isRecord(value) && Array.isArray(value.images) ? value.images : null;
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !path.isAbsolute(value) && !/[\u0000-\u001f\u007f\\:]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && part.length <= 255);
}

// Scan the complete bounded scope, rather than guessing which subfolder contains
// images. All directory identities and entry versions are retained privately.
async function scanDirectoryScope(source) {
  const entries = [], directories = [], catalog = new Map(), manifests = [], ignoredManifests = [];
  let jsonCount = 0, jsonBytes = 0;
  async function visit(directory, relative, depth, ancestorPins) {
    await assertPins(ancestorPins);
    const before = await currentStat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) fail('SOURCE_CHANGED');
    const names = await entryNames(directory);
    const directoryEntry = { path: directory, pin: filePin(before), names, ancestorPins };
    directories.push(directoryEntry);
    for (const name of names) {
      const relativePath = relative ? `${relative}/${name}` : name;
      if (!safeRelativePath(relativePath)) fail('UNSAFE_PATH');
      if (entries.length >= CAPS.entries) fail('DIRECTORY_TOO_LARGE');
      await assertPins(ancestorPins);
      const filename = path.join(directory, name);
      const stat = await currentStat(filename);
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      const entry = { path: filename, relativePath, kind, pin: filePin(stat), ancestorPins };
      entries.push(entry);
      if (kind === 'directory') {
        if (depth >= CAPS.directoryDepth) fail('DIRECTORY_TOO_DEEP');
        await visit(filename, relativePath, depth + 1, [...ancestorPins, { path: filename, type: 'directory', ...identity(stat) }]);
      } else if (IMAGE_EXTENSION.test(name)) {
        catalog.set(relativePath, { name, relativePath, leadingId: leadingId(name), pin: entry.pin,
          ancestorPins, blocked: kind === 'symlink' ? 'SOURCE_SYMLINK' : kind !== 'file' ? 'INVALID_SOURCE_FILE' : null });
      }
      if (/\.json$/i.test(name)) {
        if (++jsonCount > CAPS.manifests) fail('TOO_MANY_MANIFESTS');
        if (kind !== 'file') {
          ignoredManifests.push({ relativePath, code: kind === 'symlink' ? 'UNSAFE_PATH' : 'INVALID_MANIFEST' });
          continue;
        }
        if (entry.pin.size > CAPS.manifest) fail('MANIFEST_TOO_LARGE');
        jsonBytes += entry.pin.size;
        if (jsonBytes > CAPS.totalManifestBytes) fail('MANIFEST_TOTAL_TOO_LARGE');
        const read = await boundedRead(filename, CAPS.manifest, ancestorPins, entry.pin, 'MANIFEST_TOO_LARGE');
        entry.sha256 = sha(read.bytes);
        let records, invalidCode;
        try { records = extractManifestRecords(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))); }
        catch { invalidCode = 'INVALID_MANIFEST'; }
        if (!invalidCode && !Array.isArray(records)) invalidCode = 'INVALID_MANIFEST';
        if (!invalidCode && (!records.length || records.length > CAPS.records)) invalidCode = 'MANIFEST_TOO_LARGE';
        if (invalidCode) ignoredManifests.push({ relativePath, code: invalidCode });
        else manifests.push({ relativePath, records, bytes: read.bytes, pin: read.pin, ancestorPins, path: filename, sha256: entry.sha256 });
      }
    }
    await assertPins(ancestorPins);
  }
  await visit(source.absolute, '', 0, source.pins);
  const scope = { source, entries, directories, catalog, manifests, ignoredManifests, jsonCount, jsonBytes };
  await assertDirectoryScope(scope);
  return scope;
}

async function assertDirectoryScope(scope, hashManifests = false) {
  await assertPins(scope.source.pins);
  for (const directory of scope.directories) {
    let stat;
    try { stat = await fs.lstat(directory.path); } catch { fail('SOURCE_CHANGED'); }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFile(stat, directory.pin)) fail('SOURCE_CHANGED');
    if (JSON.stringify(await entryNames(directory.path)) !== JSON.stringify(directory.names)) fail('SOURCE_CHANGED');
  }
  for (const entry of scope.entries) {
    let stat;
    try { stat = await fs.lstat(entry.path); } catch { fail('SOURCE_CHANGED'); }
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
    if (kind !== entry.kind || !sameFile(stat, entry.pin)) fail('SOURCE_CHANGED');
    if (hashManifests && entry.sha256) {
      const read = await boundedRead(entry.path, CAPS.manifest, entry.ancestorPins, entry.pin, 'MANIFEST_TOO_LARGE');
      if (sha(read.bytes) !== entry.sha256) fail('SOURCE_CHANGED');
    }
  }
  await assertPins(scope.source.pins);
}

async function discoverBatchDirectory({ directory } = {}) {
  const source = await absolutePins(directory, 'directory');
  const scope = await scanDirectoryScope(source);
  if (!scope.manifests.length) fail(scope.jsonCount ? 'INVALID_MANIFEST' : 'NO_MANIFEST');
  const discovery = deepFreeze({ sourceDirectory: source.absolute,
    manifests: scope.manifests.map(manifest => ({ relativePath: manifest.relativePath, recordCount: manifest.records.length })),
    imageCount: [...scope.catalog.values()].filter(image => !image.blocked).length,
    ignoredManifests: scope.ignoredManifests, limits: { depth: CAPS.directoryDepth, entries: CAPS.entries,
      manifests: CAPS.manifests, records: CAPS.records, manifestBytes: CAPS.manifest, totalManifestBytes: CAPS.totalManifestBytes } });
  discoveryTrust.set(discovery, scope);
  return discovery;
}

async function prepareDirectoryBatchImport({ discovery, manifestRelativePath, type = 'photo', validateImage, derivedChinesePrompts } = {}) {
  const scope = discoveryTrust.get(discovery);
  if (!scope) fail('INVALID_DISCOVERY');
  if (manifestRelativePath === undefined && scope.manifests.length !== 1) fail('MANIFEST_SELECTION_REQUIRED');
  const manifest = manifestRelativePath === undefined ? scope.manifests[0]
    : scope.manifests.find(candidate => candidate.relativePath === manifestRelativePath);
  if (!manifest || !safeRelativePath(manifest.relativePath)) fail('INVALID_MANIFEST');
  await assertDirectoryScope(scope, true);
  return preparePlan({ source: scope.source, manifestSource: { absolute: manifest.path,
    pins: [...manifest.ancestorPins, { path: manifest.path, type: 'file', ...manifest.pin }] },
    manifestRead: { bytes: Buffer.from(manifest.bytes), pin: manifest.pin }, rawRecords: manifest.records,
    catalog: scope.catalog, scope, type, validateImage, derivedChinesePrompts });
}

async function prepareBatchImport({ imageDirectory, manifestPath, type = 'photo', validateImage } = {}) {
  if (!['photo', 'art'].includes(type)) fail('INVALID_TYPE');
  if (validateImage !== undefined && typeof validateImage !== 'function') fail('INVALID_SOURCE');
  const source = await absolutePins(imageDirectory, 'directory');
  const manifestSource = await absolutePins(manifestPath, 'file');
  const manifestRead = await boundedRead(manifestSource.absolute, CAPS.manifest, manifestSource.pins, manifestSource.pins.at(-1), 'MANIFEST_TOO_LARGE');
  let rawRecords;
  try { rawRecords = extractManifestRecords(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestRead.bytes))); }
  catch { fail('INVALID_MANIFEST'); }
  if (!Array.isArray(rawRecords)) fail('INVALID_MANIFEST');
  if (!rawRecords.length || rawRecords.length > CAPS.records) fail('MANIFEST_TOO_LARGE');
  deepFreeze(rawRecords);
  const names = await entryNames(source.absolute);
  const catalog = new Map();
  for (const name of names) {
    const stat = await fs.lstat(path.join(source.absolute, name));
    if (!IMAGE_EXTENSION.test(name)) continue;
    const blocked = stat.isSymbolicLink() ? 'SOURCE_SYMLINK' : !stat.isFile() ? 'INVALID_SOURCE_FILE' : null;
    catalog.set(name, { name, relativePath: name, leadingId: leadingId(name), blocked, pin: filePin(stat), ancestorPins: source.pins });
  }
  return preparePlan({ source, manifestSource, manifestRead, rawRecords, catalog, names, type, validateImage });
}

async function preparePlan({ source, manifestSource, manifestRead, rawRecords, catalog, names, scope, type, validateImage, derivedChinesePrompts }) {
  if (!['photo', 'art'].includes(type)) fail('INVALID_TYPE');
  if (validateImage !== undefined && typeof validateImage !== 'function') fail('INVALID_SOURCE');
  deepFreeze(rawRecords);
  const manifestSha256 = sha(manifestRead.bytes);
  const issues = [];
  const issue = (code, message, fields = {}, severity = 'error') => { const value = { code, message, severity, ...fields }; issues.push(value); return code; };
  for (const image of catalog.values()) {
    if (image.blocked) issue(image.blocked, '来源图片必须是普通文件，不能是目录或符号链接。',
      { sourceFileName: image.name, ...(scope ? { sourceRelativePath: image.relativePath } : {}) });
  }
  const preparedRows = rawRecords.map((raw, index) => ({ raw, index, id: isRecord(raw) ? idValue(raw.id) : null, image: isRecord(raw) ? imageName(raw, Boolean(scope)) : { error: 'INVALID_RECORD' } }));
  const idCounts = new Map(), imageCounts = new Map();
  for (const row of preparedRows) {
    if (row.id !== null) idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
    if (row.image.name) imageCounts.set(row.image.name, (imageCounts.get(row.image.name) ?? 0) + 1);
  }
  const translations = validateDerivedChinesePrompts(preparedRows, idCounts, derivedChinesePrompts);
  const records = [], recordResults = [], matchedImages = [], usedNames = new Set();
  let totalBytes = 0;
  for (const row of preparedRows) {
    const { raw, index, id } = row;
    const codes = [];
    const rowIssue = (code, message, severity = 'error') => codes.push(issue(code, message, { recordIndex: index, ...(id === null ? {} : { id }) }, severity));
    const result = { index, id, label: typeof raw?.label === 'string' ? raw.label : '', status: 'error', issueCodes: codes };
    recordResults.push(result);
    if (!isRecord(raw)) { rowIssue('INVALID_RECORD', '每条记录必须是 JSON 对象。'); continue; }
    if (id === null) { rowIssue('INVALID_ID', '记录编号必须是 1 至 999999 的整数。'); continue; }
    if (idCounts.get(id) > 1) { rowIssue('DUPLICATE_ID', '记录编号重复，无法确定配对。'); continue; }
    if (row.image.error) { rowIssue(row.image.error, '记录图片文件名无效或相互冲突。'); continue; }
    if (row.image.name && imageCounts.get(row.image.name) > 1) { rowIssue('DUPLICATE_IMAGE_NAME', '多个记录使用同一图片文件名。'); continue; }
    const basename = row.image.name ? path.basename(row.image.name) : null;
    if (basename && leadingId(basename) !== null && leadingId(basename) !== id) { rowIssue('ID_FILENAME_MISMATCH', '记录编号与图片文件名前缀不一致。'); continue; }
    let candidates = [], matchMethod;
    const explicitRelative = scope && row.image.name?.includes('/');
    if (row.image.name) {
      candidates = explicitRelative ? (catalog.has(row.image.name) ? [catalog.get(row.image.name)] : [])
        : [...catalog.values()].filter(file => file.name === row.image.name);
      if (candidates.length) matchMethod = 'exact';
    }
    if (!candidates.length && row.image.name && !explicitRelative && leadingId(basename) === id) {
      candidates = [...catalog.values()].filter(file => {
        const prefix = /^(\d{1,6})[-_](.+)$/.exec(file.name);
        return prefix && idValue(prefix[1]) === id && prefix[2] === row.image.name;
      });
      if (candidates.length) matchMethod = 'duplicate-leading-id-prefix';
    }
    // An explicit filename identifies a specific image. A same-ID image with a
    // different stem must never silently replace it; ID-only matching is reserved
    // for records that did not provide any filename field.
    if (!candidates.length && !row.image.name) {
      candidates = [...catalog.values()].filter(file => file.leadingId === id);
      matchMethod = 'leading-id';
    }
    if (!candidates.length) { result.status = 'unmatched'; rowIssue('IMAGE_NOT_FOUND', '未找到此编号对应的来源图片。'); continue; }
    if (candidates.length !== 1) { rowIssue('AMBIGUOUS_IMAGE', '同编号有多张候选图片，不能自动配对。'); continue; }
    const image = candidates[0];
    result.sourceFileName = image.name; result.matchMethod = matchMethod;
    if (scope) result.sourceRelativePath = image.relativePath;
    if (image.blocked) { rowIssue(image.blocked, '对应图片不是可读取的普通文件。'); continue; }
    if (image.leadingId !== null && image.leadingId !== id) { rowIssue('ID_FILENAME_MISMATCH', '来源图片编号与记录不一致。'); continue; }
    if (usedNames.has(image.relativePath)) { rowIssue('IMAGE_ALREADY_MATCHED', '同一来源图片不能配对多个记录。'); continue; }
    usedNames.add(image.relativePath);
    const filename = path.join(source.absolute, image.relativePath);
    let read;
    try { read = await boundedRead(filename, CAPS.image, image.ancestorPins, image.pin, 'IMAGE_TOO_LARGE'); }
    catch (error) {
      if (error instanceof BatchImportError && ['READ_FAILED', 'IMAGE_TOO_LARGE'].includes(error.code)) {
        rowIssue(error.code, error.message); continue;
      }
      throw error;
    }
    totalBytes += read.bytes.length;
    if (totalBytes > CAPS.totalImages) fail('BATCH_TOO_LARGE');
    const mime = imageMime(read.bytes);
    if (!mime || !extensionMatches(image.name, mime)) { rowIssue('INVALID_IMAGE', '图片内容无效或与扩展名不符。'); continue; }
    let decoded = false;
    if (validateImage) {
      try { decoded = (await validateImage(read.bytes, { path: filename, mime, id })) !== false; }
      catch { decoded = false; }
      if (!decoded) { rowIssue('INVALID_IMAGE', '图片无法解码，不能导入。'); continue; }
    }
    await assertPins(image.ancestorPins);
    const afterValidation = await currentStat(filename);
    if (afterValidation.isSymbolicLink() || !sameFile(afterValidation, read.pin) || await fs.realpath(filename) !== filename) fail('SOURCE_CHANGED');
    const imageInfo = { sourceImagePath: filename, sourceFileName: image.name, sha256: sha(read.bytes), size: read.bytes.length,
      mime, dev: read.pin.dev, ino: read.pin.ino, pin: read.pin, ancestorPins: image.ancestorPins };
    matchedImages.push(imageInfo);
    const en = promptField(raw, ['prompt_en', 'prompt', 'prompts.en']);
    let zh = promptField(raw, ['prompt_cn', 'prompt_zh', 'prompts.zh']);
    let translationProvenance;
    if (translations.has(id)) {
      zh = { value: translations.get(id), origin: 'derived-translation' };
      translationProvenance = Object.freeze({ kind: 'derived-translation', origin: 'assistant-translation',
        sourceLanguage: 'en', targetLanguage: 'zh', sourcePromptField: en.origin,
        sourcePromptSha256: sha(Buffer.from(en.value, 'utf8')), translatedPromptSha256: sha(Buffer.from(zh.value, 'utf8')),
        sourceId: id, recordIndex: index, manifestSha256 });
    }
    if (!en.value) rowIssue(en.invalid ? 'INVALID_PROMPT_EN' : 'MISSING_PROMPT_EN', '原记录缺少有效的英文提示词，没有补写或翻译。');
    if (!zh.value) rowIssue(zh.invalid ? 'INVALID_PROMPT_ZH' : 'MISSING_PROMPT_ZH', '原记录缺少有效的中文提示词，没有补写或翻译。');
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 160 || /[\u0000-\u001f\u007f]/.test(raw.label)) rowIssue('INVALID_LABEL', '记录名称不能为空，且最多 160 个字符。');
    const sourceType = ['photo', 'art'].includes(raw.type) ? raw.type : ['photo', 'art'].includes(raw.category) ? raw.category : null;
    if (!sourceType) rowIssue('SELECTED_DEFAULT_TYPE', '原记录没有应用支持的分类，使用本次选择的默认类型。', 'info');
    if (codes.some(code => issues.some(item => item.recordIndex === index && item.code === code && item.severity === 'error'))) continue;
    result.status = 'importable';
    records.push(Object.freeze({ id, label: raw.label, type: sourceType ?? type, typeOrigin: sourceType ? 'source' : 'selected-default',
      prompts: Object.freeze({ en: en.value, zh: zh.value }), promptOrigins: Object.freeze({ en: en.origin, zh: zh.origin }),
      ...(translationProvenance ? { translationProvenance } : {}),
      originalMetadata: raw, recordIndex: index, matchMethod, sourceImagePath: filename, sourceFileName: image.name,
      ...(scope ? { sourceRelativePath: image.relativePath } : {}),
      sha256: imageInfo.sha256, size: imageInfo.size, mime, dev: read.pin.dev, ino: read.pin.ino,
      imageValidation: decoded ? 'decoded' : 'signature-only' }));
  }
  await assertPins(source.pins);
  await assertPins(manifestSource.pins, true);
  for (const image of matchedImages) {
    const current = await currentStat(image.sourceImagePath);
    if (current.isSymbolicLink() || !sameFile(current, image.pin)) fail('SOURCE_CHANGED');
  }
  if (scope) await assertDirectoryScope(scope, true);
  else if (JSON.stringify(await entryNames(source.absolute)) !== JSON.stringify(names)) fail('SOURCE_CHANGED');
  const unpaired = [...catalog.values()].filter(file => !usedNames.has(file.relativePath)).map(file => ({ sourceFileName: file.name,
    ...(scope ? { sourceRelativePath: file.relativePath } : {}),
    reason: file.blocked ?? 'NO_UNIQUE_MANIFEST_RECORD' }));
  const counts = { total: rawRecords.length, matched: matchedImages.length, importable: records.length,
    errors: recordResults.filter(row => row.status === 'error').length,
    unmatched: recordResults.filter(row => row.status === 'unmatched').length, unpaired: unpaired.length };
  const plan = Object.freeze({ manifestBytes: manifestRead.bytes, manifestSha256, manifestPath: manifestSource.absolute,
    sourceDirectory: source.absolute, pins: deepFreeze({ sourceDirectory: source.pins.at(-1), manifestParent: manifestSource.pins.at(-2),
      manifestFile: manifestSource.pins.at(-1), sourceAncestors: source.pins, manifestAncestors: manifestSource.pins }),
    records: Object.freeze(records), recordResults: deepFreeze(recordResults), issues: deepFreeze(issues), unpaired: deepFreeze(unpaired),
    counts: Object.freeze(counts), matchedCount: counts.matched, importableCount: counts.importable });
  trust.set(plan, { sourcePins: source.pins, manifestPins: manifestSource.pins, manifestSha256,
    sourceNames: names, matchedImages, manifestPath: manifestSource.absolute, sourceDirectory: source.absolute, scope });
  return plan;
}

async function revalidateBatchImport(plan) {
  const expected = trust.get(plan);
  if (!expected || !Buffer.isBuffer(plan.manifestBytes) || sha(plan.manifestBytes) !== expected.manifestSha256) fail('INVALID_PLAN');
  await assertPins(expected.sourcePins);
  await assertPins(expected.manifestPins, true);
  if (expected.scope) await assertDirectoryScope(expected.scope, true);
  else if (JSON.stringify(await entryNames(expected.sourceDirectory)) !== JSON.stringify(expected.sourceNames)) fail('SOURCE_CHANGED');
  const manifest = await boundedRead(expected.manifestPath, CAPS.manifest, expected.manifestPins, expected.manifestPins.at(-1), 'MANIFEST_TOO_LARGE');
  if (sha(manifest.bytes) !== expected.manifestSha256) fail('SOURCE_CHANGED');
  for (const image of expected.matchedImages) {
    const bytes = await boundedRead(image.sourceImagePath, CAPS.image, image.ancestorPins, image.pin);
    if (sha(bytes.bytes) !== image.sha256 || imageMime(bytes.bytes) !== image.mime) fail('SOURCE_CHANGED');
  }
  await assertPins(expected.sourcePins);
  await assertPins(expected.manifestPins, true);
  if (expected.scope) await assertDirectoryScope(expected.scope, true);
  else if (JSON.stringify(await entryNames(expected.sourceDirectory)) !== JSON.stringify(expected.sourceNames)) fail('SOURCE_CHANGED');
  return { valid: true, manifestSha256: expected.manifestSha256, matchedCount: expected.matchedImages.length };
}

module.exports = { discoverBatchDirectory, prepareDirectoryBatchImport, prepareBatchImport, extractManifestRecords, revalidateBatchImport, BatchImportError, CAPS };
