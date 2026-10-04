'use strict';

// Transport preparation only. Pairing, prompts, classification, ID allocation,
// duplicate detection and import transactions belong to the Go service.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { RemoteError, imageMime, safeRelativePath } = require('./remote-client.cjs');

const CAPS = Object.freeze({ depth: 3, entries: 5000, manifest: 32 * 1024 * 1024, image: 30 * 1024 * 1024, totalImages: 1024 * 1024 * 1024 });
const IMAGE = /\.(png|jpe?g|webp)$/i;
const trust = new WeakMap();
const fail = code => { throw new RemoteError(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const identity = (stat, expected) => stat.dev === expected.dev && stat.ino === expected.ino;
const same = (stat, expected) => identity(stat, expected) && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
async function stat(filename) { try { return await fs.lstat(filename); } catch { fail('SOURCE_CHANGED'); } }
async function realRoot(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(directory) || directory.split(path.sep).some(part => part === '.' || part === '..')) fail('INVALID_SOURCE');
  const ancestors = []; let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const value = await stat(current);
    if (value.isSymbolicLink()) fail('UNSAFE_PATH'); if (!value.isDirectory()) fail('INVALID_SOURCE');
    ancestors.push({ path: current, ...pin(value) });
  }
  if (!ancestors.length || await fs.realpath(directory) !== directory) fail('UNSAFE_PATH');
  return ancestors;
}
async function assertAncestors(ancestors) {
  for (const expected of ancestors) {
    const current = await stat(expected.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !identity(current, expected)) fail('SOURCE_CHANGED');
  }
}
async function boundedNames(directory, maximum = CAPS.entries, code = 'DIRECTORY_TOO_LARGE') {
  const names = [], handle = await fs.opendir(directory);
  for await (const entry of handle) { if (names.length >= maximum) fail(code); names.push(entry.name); }
  return names.sort();
}
async function read(filename, maximum, ancestors, expected, code) {
  await assertAncestors(ancestors);
  let handle;
  try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail('SOURCE_CHANGED'); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !same(before, expected)) fail('SOURCE_CHANGED');
    if (before.size > maximum) fail(code);
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) fail('SOURCE_CHANGED'); offset += result.bytesRead; }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length), after = await handle.stat(), current = await stat(filename);
    if (extra.bytesRead || !same(after, expected) || current.isSymbolicLink() || !same(current, expected)) fail('SOURCE_CHANGED');
    await assertAncestors(ancestors);
    if (await fs.realpath(filename) !== filename) fail('SOURCE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
async function assertScope(scope, hashFiles = false) {
  await assertAncestors(scope.ancestors);
  for (const directory of scope.directories) {
    const current = await stat(directory.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !same(current, directory.pin)) fail('SOURCE_CHANGED');
    const names = await boundedNames(directory.path, directory.names.length, 'SOURCE_CHANGED');
    if (names.length !== directory.names.length || names.some((name, index) => name !== directory.names[index])) fail('SOURCE_CHANGED');
  }
  for (const entry of scope.entries) {
    const current = await stat(entry.path);
    if (current.isSymbolicLink() || !same(current, entry.pin) || (entry.directory ? !current.isDirectory() : !current.isFile())) fail('SOURCE_CHANGED');
  }
  if (hashFiles) for (const file of [scope.manifest, ...scope.images]) {
    const bytes = await read(file.path, file === scope.manifest ? CAPS.manifest : CAPS.image, file.ancestors, file.pin, file === scope.manifest ? 'MANIFEST_TOO_LARGE' : 'IMAGE_TOO_LARGE');
    if (sha(bytes) !== file.sha256) fail('SOURCE_CHANGED');
  }
  if (hashFiles) await assertScope(scope, false);
  await assertAncestors(scope.ancestors);
}

async function prepareDirectoryUpload({ directory, manifestRelativePath } = {}) {
  if (!safeRelativePath(manifestRelativePath) || !/\.json$/i.test(manifestRelativePath)) fail('INVALID_MANIFEST');
  const ancestors = await realRoot(directory), entries = [], directories = [], files = [];
  async function visit(filename, relative, depth, parentPins) {
    await assertAncestors(parentPins); const before = await stat(filename);
    if (before.isSymbolicLink() || !before.isDirectory()) fail('SOURCE_CHANGED');
    const names = await boundedNames(filename), currentPins = [...parentPins, { path: filename, ...pin(before) }];
    directories.push({ path: filename, pin: pin(before), names });
    for (const name of names) {
      const relativePath = relative ? `${relative}/${name}` : name;
      if (!safeRelativePath(relativePath)) fail('UNSAFE_PATH');
      if (entries.length >= CAPS.entries) fail('DIRECTORY_TOO_LARGE');
      const absolute = path.join(filename, name), current = await stat(absolute);
      if (current.isSymbolicLink()) fail('UNSAFE_PATH');
      if (!current.isFile() && !current.isDirectory()) fail('INVALID_SOURCE');
      const entry = { path: absolute, relativePath, pin: pin(current), directory: current.isDirectory(), ancestors: currentPins };
      entries.push(entry);
      if (entry.directory) { if (depth >= CAPS.depth) fail('DIRECTORY_TOO_DEEP'); await visit(absolute, relativePath, depth + 1, currentPins); }
      else if (relativePath === manifestRelativePath || IMAGE.test(name)) files.push(entry);
    }
    const after = await stat(filename);
    if (!same(after, pin(before))) fail('SOURCE_CHANGED'); await assertAncestors(parentPins);
  }
  await visit(directory, '', 0, ancestors);
  const manifest = files.find(file => file.relativePath === manifestRelativePath);
  if (!manifest) fail('INVALID_MANIFEST');
  const manifestBytes = await read(manifest.path, CAPS.manifest, manifest.ancestors, manifest.pin, 'MANIFEST_TOO_LARGE');
  manifest.sha256 = sha(manifestBytes);
  const uploadImages = [], images = []; let total = 0;
  for (const file of files) if (file !== manifest && IMAGE.test(file.relativePath)) {
    const bytes = await read(file.path, CAPS.image, file.ancestors, file.pin, 'IMAGE_TOO_LARGE');
    total += bytes.length; if (total > CAPS.totalImages) fail('BATCH_TOO_LARGE');
    const mime = imageMime(bytes); file.sha256 = sha(bytes); images.push(file);
    uploadImages.push(Object.freeze({ relativePath: file.relativePath, bytes, mime, size: bytes.length, sha256: file.sha256 }));
  }
  const scope = { ancestors, entries, directories, manifest, images };
  await assertScope(scope);
  const plan = Object.freeze({ sourceDirectory: directory, manifestRelativePath, manifestBytes, manifestSha256: manifest.sha256, images: Object.freeze(uploadImages), totalBytes: total });
  trust.set(plan, scope); return plan;
}
async function revalidateDirectoryUpload(plan) {
  const scope = trust.get(plan); if (!scope) fail('INVALID_PLAN');
  if (!Buffer.isBuffer(plan.manifestBytes) || sha(plan.manifestBytes) !== scope.manifest.sha256 || plan.images.length !== scope.images.length) fail('INVALID_PLAN');
  for (let index = 0; index < plan.images.length; index++) {
    const supplied = plan.images[index], expected = scope.images[index];
    if (!Buffer.isBuffer(supplied.bytes) || supplied.relativePath !== expected.relativePath || sha(supplied.bytes) !== expected.sha256) fail('INVALID_PLAN');
  }
  await assertScope(scope, true); return { valid: true, manifestSha256: scope.manifest.sha256, imageCount: scope.images.length };
}

module.exports = { prepareDirectoryUpload, revalidateDirectoryUpload, CAPS };
