'use strict';

// Main-process, read-only planning. Files are copied only by the separate local
// library transaction after this private plan has been revalidated.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CAPS = Object.freeze({ records: 500, entries: 5000, manifest: 32 * 1024 * 1024,
  image: 30 * 1024 * 1024, totalImages: 1024 * 1024 * 1024, prompt: 65536, metadataDepth: 24 });
const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;
const trust = new WeakMap();
const MESSAGES = {
  INVALID_SOURCE: '请选择真实的本地图片目录和 JSON 版本文档。',
  UNSAFE_PATH: '来源路径不能越界或包含符号链接。',
  SOURCE_CHANGED: '导入来源发生变化，请重新预览。',
  READ_FAILED: '无法读取导入来源，请检查文件权限。',
  INVALID_MANIFEST: '导入文档必须是有效 UTF-8 JSON 记录数组。',
  MANIFEST_TOO_LARGE: '导入文档超过允许大小或记录数量。',
  DIRECTORY_TOO_LARGE: '图片目录中的文件数量超过允许范围。',
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
    const current = await fs.lstat(filename);
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
function imageName(record) {
  const fields = ['image', 'filename', 'fileName', 'image_file'].filter(field => Object.hasOwn(record, field));
  if (!fields.length) return { name: null };
  if (fields.some(field => typeof record[field] !== 'string') || new Set(fields.map(field => record[field])).size !== 1) return { error: 'INVALID_IMAGE_NAME' };
  const name = record[fields[0]];
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f/\\:]/.test(name) || name === '.' || name === '..' || !IMAGE_EXTENSION.test(name)) return { error: 'INVALID_IMAGE_NAME' };
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

async function prepareBatchImport({ imageDirectory, manifestPath, type = 'photo', validateImage } = {}) {
  if (!['photo', 'art'].includes(type)) fail('INVALID_TYPE');
  if (validateImage !== undefined && typeof validateImage !== 'function') fail('INVALID_SOURCE');
  const source = await absolutePins(imageDirectory, 'directory');
  const manifestSource = await absolutePins(manifestPath, 'file');
  const manifestRead = await boundedRead(manifestSource.absolute, CAPS.manifest, manifestSource.pins, manifestSource.pins.at(-1), 'MANIFEST_TOO_LARGE');
  let rawRecords;
  try { rawRecords = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestRead.bytes)); }
  catch { fail('INVALID_MANIFEST'); }
  if (!Array.isArray(rawRecords)) fail('INVALID_MANIFEST');
  if (!rawRecords.length || rawRecords.length > CAPS.records) fail('MANIFEST_TOO_LARGE');
  deepFreeze(rawRecords);
  const names = await entryNames(source.absolute);
  const catalog = new Map();
  const issues = [];
  const issue = (code, message, fields = {}, severity = 'error') => { const value = { code, message, severity, ...fields }; issues.push(value); return code; };
  for (const name of names) {
    const stat = await fs.lstat(path.join(source.absolute, name));
    if (!IMAGE_EXTENSION.test(name)) continue;
    const blocked = stat.isSymbolicLink() ? 'SOURCE_SYMLINK' : !stat.isFile() ? 'INVALID_SOURCE_FILE' : null;
    catalog.set(name, { name, leadingId: leadingId(name), blocked, pin: filePin(stat) });
    if (blocked) issue(blocked, '来源图片必须是普通文件，不能是目录或符号链接。', { sourceFileName: name });
  }
  const preparedRows = rawRecords.map((raw, index) => ({ raw, index, id: isRecord(raw) ? idValue(raw.id) : null, image: isRecord(raw) ? imageName(raw) : { error: 'INVALID_RECORD' } }));
  const idCounts = new Map(), imageCounts = new Map();
  for (const row of preparedRows) {
    if (row.id !== null) idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
    if (row.image.name) imageCounts.set(row.image.name, (imageCounts.get(row.image.name) ?? 0) + 1);
  }
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
    if (row.image.name && leadingId(row.image.name) !== null && leadingId(row.image.name) !== id) { rowIssue('ID_FILENAME_MISMATCH', '记录编号与图片文件名前缀不一致。'); continue; }
    let candidates = [], matchMethod;
    if (row.image.name && catalog.has(row.image.name)) {
      candidates = [catalog.get(row.image.name)]; matchMethod = 'exact';
    } else if (row.image.name && leadingId(row.image.name) === id) {
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
    if (image.blocked) { rowIssue(image.blocked, '对应图片不是可读取的普通文件。'); continue; }
    if (image.leadingId !== null && image.leadingId !== id) { rowIssue('ID_FILENAME_MISMATCH', '来源图片编号与记录不一致。'); continue; }
    if (usedNames.has(image.name)) { rowIssue('IMAGE_ALREADY_MATCHED', '同一来源图片不能配对多个记录。'); continue; }
    usedNames.add(image.name);
    const filename = path.join(source.absolute, image.name);
    let read;
    try { read = await boundedRead(filename, CAPS.image, source.pins, image.pin, 'IMAGE_TOO_LARGE'); }
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
    const afterValidation = await fs.lstat(filename);
    if (afterValidation.isSymbolicLink() || !sameFile(afterValidation, read.pin) || await fs.realpath(filename) !== filename) fail('SOURCE_CHANGED');
    const imageInfo = { sourceImagePath: filename, sourceFileName: image.name, sha256: sha(read.bytes), size: read.bytes.length,
      mime, dev: read.pin.dev, ino: read.pin.ino, pin: read.pin };
    matchedImages.push(imageInfo);
    const en = promptField(raw, ['prompt_en', 'prompt', 'prompts.en']);
    const zh = promptField(raw, ['prompt_cn', 'prompt_zh', 'prompts.zh']);
    if (!en.value) rowIssue(en.invalid ? 'INVALID_PROMPT_EN' : 'MISSING_PROMPT_EN', '原记录缺少有效的英文提示词，没有补写或翻译。');
    if (!zh.value) rowIssue(zh.invalid ? 'INVALID_PROMPT_ZH' : 'MISSING_PROMPT_ZH', '原记录缺少有效的中文提示词，没有补写或翻译。');
    if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 160 || /[\u0000-\u001f\u007f]/.test(raw.label)) rowIssue('INVALID_LABEL', '记录名称不能为空，且最多 160 个字符。');
    const sourceType = ['photo', 'art'].includes(raw.type) ? raw.type : ['photo', 'art'].includes(raw.category) ? raw.category : null;
    if (!sourceType) rowIssue('SELECTED_DEFAULT_TYPE', '原记录没有应用支持的分类，使用本次选择的默认类型。', 'info');
    if (codes.some(code => issues.some(item => item.recordIndex === index && item.code === code && item.severity === 'error'))) continue;
    result.status = 'importable';
    records.push(Object.freeze({ id, label: raw.label, type: sourceType ?? type, typeOrigin: sourceType ? 'source' : 'selected-default',
      prompts: Object.freeze({ en: en.value, zh: zh.value }), promptOrigins: Object.freeze({ en: en.origin, zh: zh.origin }),
      originalMetadata: raw, recordIndex: index, matchMethod, sourceImagePath: filename, sourceFileName: image.name,
      sha256: imageInfo.sha256, size: imageInfo.size, mime, dev: read.pin.dev, ino: read.pin.ino,
      imageValidation: decoded ? 'decoded' : 'signature-only' }));
  }
  await assertPins(source.pins);
  await assertPins(manifestSource.pins, true);
  for (const image of matchedImages) {
    const current = await fs.lstat(image.sourceImagePath);
    if (current.isSymbolicLink() || !sameFile(current, image.pin)) fail('SOURCE_CHANGED');
  }
  if (JSON.stringify(await entryNames(source.absolute)) !== JSON.stringify(names)) fail('SOURCE_CHANGED');
  const unpaired = [...catalog.values()].filter(file => !usedNames.has(file.name)).map(file => ({ sourceFileName: file.name,
    reason: file.blocked ?? 'NO_UNIQUE_MANIFEST_RECORD' }));
  const counts = { total: rawRecords.length, matched: matchedImages.length, importable: records.length,
    errors: recordResults.filter(row => row.status === 'error').length,
    unmatched: recordResults.filter(row => row.status === 'unmatched').length, unpaired: unpaired.length };
  const manifestSha256 = sha(manifestRead.bytes);
  const plan = Object.freeze({ manifestBytes: manifestRead.bytes, manifestSha256, manifestPath: manifestSource.absolute,
    sourceDirectory: source.absolute, pins: deepFreeze({ sourceDirectory: source.pins.at(-1), manifestParent: manifestSource.pins.at(-2),
      manifestFile: manifestSource.pins.at(-1), sourceAncestors: source.pins, manifestAncestors: manifestSource.pins }),
    records: Object.freeze(records), recordResults: deepFreeze(recordResults), issues: deepFreeze(issues), unpaired: deepFreeze(unpaired),
    counts: Object.freeze(counts), matchedCount: counts.matched, importableCount: counts.importable });
  trust.set(plan, { sourcePins: source.pins, manifestPins: manifestSource.pins, manifestSha256,
    sourceNames: names, matchedImages, manifestPath: manifestSource.absolute, sourceDirectory: source.absolute });
  return plan;
}

async function revalidateBatchImport(plan) {
  const expected = trust.get(plan);
  if (!expected || !Buffer.isBuffer(plan.manifestBytes) || sha(plan.manifestBytes) !== expected.manifestSha256) fail('INVALID_PLAN');
  await assertPins(expected.sourcePins);
  await assertPins(expected.manifestPins, true);
  if (JSON.stringify(await entryNames(expected.sourceDirectory)) !== JSON.stringify(expected.sourceNames)) fail('SOURCE_CHANGED');
  const manifest = await boundedRead(expected.manifestPath, CAPS.manifest, expected.manifestPins, expected.manifestPins.at(-1), 'MANIFEST_TOO_LARGE');
  if (sha(manifest.bytes) !== expected.manifestSha256) fail('SOURCE_CHANGED');
  for (const image of expected.matchedImages) {
    const bytes = await boundedRead(image.sourceImagePath, CAPS.image, expected.sourcePins, image.pin);
    if (sha(bytes.bytes) !== image.sha256 || imageMime(bytes.bytes) !== image.mime) fail('SOURCE_CHANGED');
  }
  await assertPins(expected.sourcePins);
  await assertPins(expected.manifestPins, true);
  if (JSON.stringify(await entryNames(expected.sourceDirectory)) !== JSON.stringify(expected.sourceNames)) fail('SOURCE_CHANGED');
  return { valid: true, manifestSha256: expected.manifestSha256, matchedCount: expected.matchedImages.length };
}

module.exports = { prepareBatchImport, revalidateBatchImport, BatchImportError, CAPS };
