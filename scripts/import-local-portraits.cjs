'use strict';

// Default/--dry-run opens only a complete owned temporary library copy.
// The real repository is opened for writing only by an explicit --apply using
// the reviewed plan. Do not run --apply to work around an approval rejection.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { LocalLibrary } = require('../local-library.cjs');
const { discoverBatchDirectory, prepareDirectoryBatchImport, extractManifestRecords } = require('../batch-import.cjs');
const project = path.resolve(__dirname, '..');
const sourceDirectory = '/Users/jie/Downloads/chinese_beauty_50_generated_images';
const targetDirectory = path.join(project, 'photo_repo');
const translationsPath = path.join(project, '.verification/single-directory-translations.json');
const defaultPlanPath = path.join(project, '.verification/local-import-plan.json');
const resultPath = path.join(project, '.verification/local-import-result.json');
const indexRelative = '.portrait-studio/library.json';
const originalIndexSha256 = 'ad0a021d698e5aa0d1ef9ff17b9fb4c57ccde585031737a293cf7b57788e100e';
const ignoredLocks = new Set(['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json']);
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

function ordinaryFile(file, maximum = 32 * 1024 * 1024) {
  const absolute = path.resolve(file);
  let ancestor = path.parse(absolute).root;
  for (const component of absolute.slice(ancestor.length).split(path.sep)) {
    ancestor = path.join(ancestor, component);
    const stat = fs.lstatSync(ancestor);
    assert.equal(stat.isSymbolicLink(), false, 'Managed paths must not contain symbolic links');
    if (ancestor !== absolute) assert.equal(stat.isDirectory(), true);
  }
  const before = fs.lstatSync(absolute);
  assert.equal(before.isFile(), true); assert.equal(before.nlink, 1);
  assert(before.size > 0 && before.size <= maximum);
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor), raw = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor), latest = fs.lstatSync(absolute);
    const key = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    assert.deepEqual(key(before), key(opened)); assert.deepEqual(key(opened), key(after)); assert.deepEqual(key(after), key(latest));
    assert.equal(raw.length, before.size);
    return raw;
  } finally { fs.closeSync(descriptor); }
}

function fingerprint(root) {
  assert.equal(fs.realpathSync(root), path.resolve(root), 'Use a canonical ordinary root');
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
  const result = {};
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignoredLocks.has(name)) continue;
      assert.equal(entry.isSymbolicLink(), false, `No source links: ${name}`);
      if (entry.isDirectory()) walk(name);
      else {
        assert.equal(entry.isFile(), true, `Only ordinary source files: ${name}`);
        const raw = ordinaryFile(path.join(root, name), 40 * 1024 * 1024);
        result[name] = { size: raw.length, sha256: sha(raw) };
      }
    }
  }
  walk(''); return result;
}

function decodePng(bytes) {
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0 && width <= 12000 && height <= 12000 && width * height <= 100000000);
  const image = PNG.sync.read(bytes, { checkCRC: true });
  assert(image.width > 0 && image.height > 0 && image.width <= 12000 && image.height <= 12000 && image.width * image.height <= 100000000);
  return true;
}

async function trustedPlan({ source = sourceDirectory, translationsFile = translationsPath, validateImage = decodePng } = {}) {
  const manifestPath = path.join(source, 'generated_portraits_manifest.json');
  const manifestBytes = ordinaryFile(manifestPath);
  const records = extractManifestRecords(JSON.parse(manifestBytes));
  assert.equal(records.length, 50);
  assert.deepEqual(records.map(row => Number(row.id)).sort((a, b) => a - b), Array.from({ length: 50 }, (_, index) => index + 1));
  const translationBytes = ordinaryFile(translationsFile);
  const document = JSON.parse(translationBytes);
  assert.equal(document.sourceManifestSha256, sha(manifestBytes));
  const translations = document.translations;
  assert(translations && typeof translations === 'object' && !Array.isArray(translations));
  assert.deepEqual(Object.keys(translations).sort((a, b) => Number(a) - Number(b)), Array.from({ length: 50 }, (_, index) => String(index + 1)));
  for (const raw of records) {
    const english = raw.prompt_en ?? raw.prompt ?? raw.prompts?.en;
    const chinese = translations[String(Number(raw.id))];
    assert.equal(typeof english, 'string'); assert(english.trim());
    assert.equal(typeof chinese, 'string'); assert(chinese.trim() && chinese.length <= 65536 && /[\u3400-\u9fff]/.test(chinese));
    assert.deepEqual(chinese.match(/\d+(?:\.\d+)?/g), english.match(/\d+(?:\.\d+)?/g), `Preserve all numeric constraints for source ${raw.id}`);
    for (const section of ['用途：', '素材类型：', '主体：', '风格与场景：', '构图：', '约束：']) assert(chinese.includes(section));
  }
  const discovery = await discoverBatchDirectory({ directory: source });
  assert.equal(discovery.manifests.length, 1); assert.equal(discovery.imageCount, 50);
  assert.equal(discovery.manifests[0].relativePath, path.basename(manifestPath));
  const plan = await prepareDirectoryBatchImport({ discovery, derivedChinesePrompts: translations, type: 'photo', validateImage });
  assert.equal(plan.counts.total, 50); assert.equal(plan.counts.matched, 50); assert.equal(plan.records.length, 50);
  assert.equal(plan.issues.filter(issue => issue.severity === 'error').length, 0);
  assert.equal(plan.manifestSha256, sha(manifestBytes));
  return { discovery, plan, records, translations, manifestBytes, translationSha256: sha(translationBytes) };
}

function writeNewJson(file, value, { replace = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!replace) assert.equal(fs.existsSync(file), false, 'Evidence file already exists; preserve prior outcome');
  const before = replace ? ordinaryFile(file) : null;
  const temporary = path.join(path.dirname(file), `.local-import-${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, encode(value)); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    if (replace) { assert.equal(sha(ordinaryFile(file)), sha(before), 'Owned evidence changed before replacement'); fs.renameSync(temporary, file); }
    else { fs.linkSync(temporary, file); fs.unlinkSync(temporary); }
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

async function dryRun(planFile = defaultPlanPath) {
  const original = ordinaryFile(path.join(targetDirectory, indexRelative));
  assert.equal(sha(original), originalIndexSha256, 'Real library must remain the original reviewed index');
  const index = JSON.parse(original);
  assert.equal(index.schemaVersion, 1); assert.equal(index.revision, 2); assert.equal(index.items.length, 50);
  const sourceBefore = fingerprint(sourceDirectory), targetBefore = fingerprint(targetDirectory);
  assert.equal(Object.keys(sourceBefore).length, 52); assert.equal(Object.keys(targetBefore).length, 55);
  const prepared = await trustedPlan();
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-local-plan-')));
  const clone = path.join(temporary, 'isolated-repository');
  try {
    fs.cpSync(targetDirectory, clone, { recursive: true, dereference: false, errorOnExist: true,
      filter: file => !ignoredLocks.has(path.relative(targetDirectory, file).split(path.sep).join('/')) });
    assert.deepEqual(fingerprint(clone), targetBefore);
    const service = new LocalLibrary({ validateImage: decodePng });
    const initial = await service.open(clone);
    assert.equal(initial.items.length, 50); assert.equal(initial.revision, 2);
    const preview = await service.previewBatch(prepared.plan, { collisionPolicy: 'allocate-new' });
    assert.deepEqual(preview.summary, { total: 50, importable: 50, skipped: 0, conflicts: 0, invalid: 0 });
    assert.deepEqual(preview.records.map(row => [row.sourceId, row.targetId]).sort((a, b) => a[0] - b[0]), Array.from({ length: 50 }, (_, index) => [index + 1, index + 51]));
    assert.deepEqual(fingerprint(sourceDirectory), sourceBefore); assert.deepEqual(fingerprint(targetDirectory), targetBefore);
    const review = { schemaVersion: 1, kind: 'portrait-local-import-plan', status: 'read-only-plan', generatedAt: new Date().toISOString(),
      project, sourceDirectory, targetDirectory, translationsPath, originalIndexSha256, originalRevision: 2, originalCount: 50,
      targetRevision: 3, targetCount: 100, sourceManifestSha256: prepared.plan.manifestSha256, translationSha256: prepared.translationSha256,
      sourceFiles: sourceBefore, originalLibraryFiles: targetBefore, discovery: prepared.discovery, preview,
      summary: { total: 50, matched: 50, importable: 50, internalIds: '51–100', sourceIds: '1–50' },
      derivedChinese: { kind: 'derived-translation', sourceLanguage: 'en', targetLanguage: 'zh', originalChinesePresent: false, rawSourceUnchanged: true },
      readOnlyScope: 'Real library and source only read; actual LocalLibrary preview ran on a complete private temporary clone.',
      actualImportCommand: 'node scripts/import-local-portraits.cjs --apply --plan .verification/local-import-plan.json' };
    writeNewJson(planFile, review, { replace: false });
    return { status: review.status, planPath: planFile, planSha256: sha(ordinaryFile(planFile)), ...review.summary, originalCount: 50, originalRevision: 2, realLibraryWritten: false };
  } finally {
    assert(temporary.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    await fsp.rm(temporary, { recursive: true, force: true });
    assert.deepEqual(fingerprint(sourceDirectory), sourceBefore); assert.deepEqual(fingerprint(targetDirectory), targetBefore);
  }
}

async function apply(planFile) {
  assert.equal(path.resolve(planFile), defaultPlanPath, 'Real apply accepts only the reviewed fixed plan path');
  assert.equal(fs.existsSync(resultPath), false, 'Prior real import outcome exists; do not rerun writes');
  const reviewBytes = ordinaryFile(planFile), review = JSON.parse(reviewBytes);
  assert.equal(review.kind, 'portrait-local-import-plan'); assert.equal(review.status, 'read-only-plan');
  for (const [key, value] of Object.entries({ project, sourceDirectory, targetDirectory, translationsPath, originalIndexSha256,
    originalCount: 50, originalRevision: 2, targetCount: 100, targetRevision: 3 })) assert.deepEqual(review[key], value, `Fixed review field ${key}`);
  assert.equal(sha(ordinaryFile(path.join(targetDirectory, indexRelative))), originalIndexSha256);
  assert.deepEqual(fingerprint(targetDirectory), review.originalLibraryFiles); assert.deepEqual(fingerprint(sourceDirectory), review.sourceFiles);
  const prepared = await trustedPlan();
  assert.equal(prepared.plan.manifestSha256, review.sourceManifestSha256); assert.equal(prepared.translationSha256, review.translationSha256);
  assert.deepEqual(fingerprint(targetDirectory), review.originalLibraryFiles); assert.deepEqual(fingerprint(sourceDirectory), review.sourceFiles);
  let outcome = { schemaVersion: 1, kind: 'portrait-local-import-result', stage: 'production-open-requested', commitSucceeded: false,
    planPath: planFile, planSha256: sha(reviewBytes), sourceDirectory, targetDirectory, originalIndexSha256, startedAt: new Date().toISOString() };
  writeNewJson(resultPath, outcome);
  try {
    const service = new LocalLibrary({ validateImage: decodePng });
    const initial = await service.open(targetDirectory);
    assert.equal(initial.items.length, 50); assert.equal(initial.revision, 2);
    const preview = await service.previewBatch(prepared.plan, { collisionPolicy: 'allocate-new' });
    assert.deepEqual(preview, review.preview);
    assert.equal(sha(ordinaryFile(path.join(targetDirectory, indexRelative))), originalIndexSha256);
    outcome.stage = 'single-atomic-commit-requested'; writeNewJson(resultPath, outcome, { replace: true });
    const committed = await service.importBatch(prepared.plan, { expectedVersion: 2, confirmed: true, collisionPolicy: 'allocate-new' });
    outcome = { ...outcome, stage: 'committed', commitSucceeded: true, count: committed.items.length, revision: committed.revision,
      imported: committed.batch.imported, archiveRel: committed.batch.archiveRel, batch: committed.batch };
    writeNewJson(resultPath, outcome, { replace: true });
    console.log(JSON.stringify({ stage: 'committed', count: outcome.count, revision: outcome.revision, imported: outcome.imported, resultPath }));
    assert.equal(outcome.count, 100); assert.equal(outcome.revision, 3); assert.equal(outcome.imported, 50);
    const index = JSON.parse(ordinaryFile(path.join(targetDirectory, indexRelative)));
    const oldIndex = JSON.parse(ordinaryFile(path.join(project, '.verification/local-import-original-index.json')));
    assert.deepEqual(index.items.filter(item => item.id <= 50), oldIndex.items);
    assert.equal(fs.readFileSync(path.join(targetDirectory, outcome.archiveRel, 'manifest.json')).equals(prepared.manifestBytes), true);
    const after = fingerprint(targetDirectory);
    for (const [name, expected] of Object.entries(review.originalLibraryFiles)) if (name !== indexRelative) assert.deepEqual(after[name], expected);
    for (const item of index.items.filter(item => item.id > 50)) {
      const record = prepared.records.find(row => Number(row.id) === item.sourceImport.sourceId);
      assert(record); assert.equal(item.id, Number(record.id) + 50); assert.deepEqual(item.sourceMetadata, record);
      assert.equal(item.prompts.en, record.prompt_en ?? record.prompt ?? record.prompts?.en);
      assert.equal(item.prompts.zh, prepared.translations[String(record.id)]);
      assert.equal(item.sourceImport.derivedChinesePrompt, item.prompts.zh);
      assert.equal(item.sourceImport.translationProvenance.kind, 'derived-translation');
      assert.equal(item.sourceImport.translationProvenance.sourcePromptSha256, sha(item.prompts.en));
      assert.equal(item.sourceImport.translationProvenance.translatedPromptSha256, sha(item.prompts.zh));
      assert.equal(item.sha256, review.sourceFiles[item.sourceImport.sourceRelativePath].sha256);
    }
    assert.deepEqual(fingerprint(sourceDirectory), review.sourceFiles);
    outcome.stage = 'verified'; outcome.sourceUnchanged = true; outcome.old54NonIndexFilesUnchanged = true;
    outcome.finalIndexSha256 = sha(ordinaryFile(path.join(targetDirectory, indexRelative)));
    outcome.finishedAt = new Date().toISOString(); writeNewJson(resultPath, outcome, { replace: true });
    return outcome;
  } catch (error) {
    outcome.error = { name: error.name, code: error.code, message: error.message };
    outcome.stage = outcome.commitSucceeded ? 'committed-verification-failed-read-only-followup-required' : 'stopped-do-not-retry-until-reviewed';
    writeNewJson(resultPath, outcome, { replace: true });
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  let mode = 'dry-run', planFile = defaultPlanPath, explicitMode = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--dry-run') { assert.equal(explicitMode, false, 'Conflicting import modes'); explicitMode = true; }
    else if (args[index] === '--apply') { assert.equal(explicitMode, false, 'Conflicting import modes'); explicitMode = true; mode = 'apply'; }
    else if (args[index] === '--plan') { assert(args[index + 1]); planFile = path.resolve(args[++index]); }
    else throw new Error('Unknown local import option');
  }
  if (mode === 'dry-run') {
    // Review copy is evidence only; source index itself is never rewritten.
    const originalEvidence = path.join(project, '.verification/local-import-original-index.json');
    const raw = ordinaryFile(path.join(targetDirectory, indexRelative)); assert.equal(sha(raw), originalIndexSha256);
    if (!fs.existsSync(originalEvidence)) writeNewJson(originalEvidence, JSON.parse(raw));
    else assert.deepEqual(JSON.parse(ordinaryFile(originalEvidence)), JSON.parse(raw));
    console.log(JSON.stringify(await dryRun(planFile)));
  } else console.log(JSON.stringify(await apply(planFile)));
}

module.exports = { fingerprint, ordinaryFile, decodePng, trustedPlan, sha, encode, dryRun,
  project, sourceDirectory, targetDirectory, translationsPath, originalIndexSha256, indexRelative, ignoredLocks };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ status: 'stopped', error: { name: error.name, code: error.code, message: error.message }, realWriteRequiresExplicitApply: true })); process.exitCode = 1; });
