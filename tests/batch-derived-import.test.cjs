'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { LocalLibrary } = require('../local-library.cjs');
const { discoverBatchDirectory, prepareDirectoryBatchImport } = require('../batch-import.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const decode = bytes => { try { return PNG.sync.read(bytes).width > 0; } catch { return false; } };
const ALLOCATE = { collisionPolicy: 'allocate-new' };
const commit = (revision = 1) => ({ ...ALLOCATE, confirmed: true, expectedVersion: revision });
const rejectCode = (action, code) => assert.rejects(action, error => { assert.equal(error.code, code, error.stack); return true; });
function png(color) {
  const image = new PNG({ width: 3, height: 4 });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([color, 37, 91, 255], i);
  return PNG.sync.write(image);
}
function rawRecord(id) {
  return { id, label: `原始标签 ${id}`, filename: `${String(id).padStart(3, '0')}-new.png`,
    prompt_en: ` Original English ${id}.\n  Preserve 50 mm, f/2 and every constraint. `,
    description: '所有原始字段保持不变', original_prompt: `source ${id}`, nested: { tags: ['源字段', id], retained: true } };
}
async function snapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, name), stat = await fs.lstat(absolute), key = path.relative(root, absolute);
      if (stat.isDirectory()) { result[key] = 'directory'; await visit(absolute); }
      else result[key] = sha(await fs.readFile(absolute));
    }
  }
  await visit(root); return result;
}
async function index(f) { return JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/library.json'), 'utf8')); }
async function fixture(t, { oldCount = 3, sourceCount = 3, reverse = false, oldIds, oldColors, sourceColors, fault } = {}) {
  const requested = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-derived-test-'));
  const base = await fs.realpath(requested), root = path.join(base, 'repository'), source = path.join(base, 'source');
  await fs.mkdir(path.join(root, 'assets/images'), { recursive: true });
  await fs.mkdir(path.join(source, 'images'), { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const originals = [], chinese = {};
  for (let i = 0; i < oldCount; i++) {
    const id = oldIds?.[i] ?? i + 1, image = `${String(id).padStart(3, '0')}-old.png`;
    originals.push({ id, image, label: `旧素材 ${id}`, prompt: `Old English ${id}` });
    chinese[id] = `旧中文 ${id}`;
    await fs.writeFile(path.join(root, 'assets/images', image), png(oldColors?.[i] ?? i + 1));
  }
  await fs.writeFile(path.join(root, 'assets/selected-prompts.json'), JSON.stringify(originals));
  await fs.writeFile(path.join(root, 'assets/prompts.zh.json'), JSON.stringify(chinese));
  const records = Array.from({ length: sourceCount }, (_, i) => rawRecord(i + 1));
  const translations = Object.fromEntries(records.map(row => [row.id, ` 原始英文的完整中文译文 ${row.id}。\n  保留 50 mm、f/2 与全部约束。 `]));
  for (const row of records) await fs.writeFile(path.join(source, 'images', row.filename), png(sourceColors?.[row.id - 1] ?? 100 + row.id));
  if (reverse) records.reverse();
  const manifestPath = path.join(source, 'manifest.json');
  const manifestBytes = Buffer.from(` \n${JSON.stringify({ generator: 'owned fixture', count: sourceCount, images: records, extra: { untouched: true } }, null, 2)}\n`);
  await fs.writeFile(manifestPath, manifestBytes);
  const discovery = await discoverBatchDirectory({ directory: source });
  const plan = await prepareDirectoryBatchImport({ discovery, derivedChinesePrompts: translations, validateImage: decode });
  const createLibrary = extras => new LocalLibrary({ validateImage: decode, fault, ...extras });
  const library = createLibrary(); await library.open(root);
  const before = await index({ root }), beforeImages = {};
  for (const item of before.items) beforeImages[item.imageRel] = sha(await fs.readFile(path.join(root, item.imageRel)));
  return { base, root, source, records, translations, manifestPath, manifestBytes, discovery, plan, library, createLibrary, before, beforeImages };
}
async function assertOldPreserved(f, next) {
  assert.deepEqual(next.items.filter(item => f.before.items.some(old => old.id === item.id)), f.before.items);
  for (const [relative, hash] of Object.entries(f.beforeImages)) assert.equal(sha(await fs.readFile(path.join(f.root, relative))), hash);
}

test('50 collisions allocate 51-100 deterministically while preserving original JSON, fields, English and derived Chinese provenance', async t => {
  const f = await fixture(t, { oldCount: 50, sourceCount: 50, reverse: true }), sourceBefore = await snapshot(f.source);
  const preview = await f.library.previewBatch(f.plan, ALLOCATE);
  assert.deepEqual(preview.summary, { total: 50, importable: 50, skipped: 0, conflicts: 0, invalid: 0 });
  for (const row of preview.records) { assert.equal(row.id, row.sourceId); assert.equal(row.targetId, row.sourceId + 50); }
  const result = await f.library.importBatch(f.plan, commit());
  assert.equal(result.batch.imported, 50); assert.equal(result.revision, 2); assert.equal(result.items.length, 100);
  const after = await index(f); await assertOldPreserved(f, after);
  for (const item of after.items.filter(item => item.id > 50)) {
    const sourceId = item.id - 50, raw = f.records.find(row => row.id === sourceId), provenance = item.sourceImport.translationProvenance;
    assert.deepEqual(item.sourceMetadata, raw); assert.equal(Object.hasOwn(item.sourceMetadata, 'prompt_cn'), false);
    assert.equal(item.prompts.en, raw.prompt_en); assert.equal(item.prompts.zh, f.translations[sourceId]);
    assert.equal(item.sourceImport.sourceId, sourceId); assert.equal(item.sourceImport.derivedChinesePrompt, f.translations[sourceId]);
    assert.deepEqual(provenance, f.plan.records.find(row => row.id === sourceId).translationProvenance);
    assert.equal(provenance.kind, 'derived-translation'); assert.equal(provenance.origin, 'assistant-translation');
    assert.equal(provenance.sourcePromptSha256, sha(Buffer.from(raw.prompt_en))); assert.equal(provenance.translatedPromptSha256, sha(Buffer.from(item.prompts.zh)));
    assert.equal(item.sha256, sha(await fs.readFile(path.join(f.source, 'images', raw.filename))));
    const mapping = result.batch.mapping.find(row => row.sourceId === sourceId);
    assert.equal(mapping.targetId, item.id); assert.equal(mapping.targetFileName, item.image); assert.equal(mapping.sourceHash, item.sha256);
    assert.deepEqual(mapping.translationProvenance, provenance); assert.equal(Object.hasOwn(mapping, 'derivedChinesePrompt'), false);
  }
  assert.deepEqual(await fs.readFile(path.join(f.root, result.batch.archiveRel, 'manifest.json')), f.manifestBytes);
  assert.deepEqual(await fs.readFile(f.manifestPath), f.manifestBytes); assert.deepEqual(await snapshot(f.source), sourceBefore);
  const archivedMapping = JSON.parse(await fs.readFile(path.join(f.root, result.batch.archiveRel, 'mapping.json'), 'utf8'));
  assert.deepEqual(archivedMapping, result.batch.mapping);
});

test('a retry skips the same image hashes across allocated IDs and leaves every byte, revision and archive count unchanged', async t => {
  const f = await fixture(t), first = await f.library.importBatch(f.plan, commit()), before = await snapshot(f.root);
  const preview = await f.library.previewBatch(f.plan, ALLOCATE); assert.equal(preview.summary.skipped, 3); assert.equal(preview.canImport, false);
  assert.deepEqual(preview.records.map(row => row.targetId), [4, 5, 6]);
  const repeated = await f.library.importBatch(f.plan, commit(first.revision));
  assert.equal(repeated.batch.imported, 0); assert.equal(repeated.batch.skipped, 3); assert.equal(repeated.revision, first.revision);
  assert.equal(repeated.batch.archiveRel, first.batch.archiveRel); assert.deepEqual(await snapshot(f.root), before);
});

test('default policy still reports collisions without replacing old entries or writing archives', async t => {
  const f = await fixture(t), before = await snapshot(f.root);
  const preview = await f.library.previewBatch(f.plan); assert.equal(preview.summary.conflicts, 3); assert.equal(preview.canImport, false);
  const result = await f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true });
  assert.equal(result.batch.imported, 0); assert.equal(result.batch.conflicts, 3); assert.deepEqual(await snapshot(f.root), before);
});

test('same hashes select the minimum existing ID and never add duplicates even if several old IDs share that hash', async t => {
  const f = await fixture(t, { oldColors: [7, 7, 9], sourceColors: [7, 7, 103] });
  const result = await f.library.importBatch(f.plan, commit()); assert.equal(result.batch.imported, 1); assert.equal(result.batch.skipped, 2);
  assert.deepEqual(result.batch.mapping.map(row => [row.sourceId, row.targetId, row.status]), [[1, 1, 'skip'], [2, 1, 'skip'], [3, 4, 'import']]);
  for (const row of result.batch.mapping.filter(row => row.status === 'skip')) { assert.equal(row.matchMethod, 'image-sha256'); assert.equal(row.skipReason, 'IMAGE_HASH_EXISTS'); }
  await assertOldPreserved(f, await index(f));
});

test('identical incoming hashes are copied once and share one explicit target mapping', async t => {
  const f = await fixture(t, { sourceColors: [101, 101, 103] });
  const result = await f.library.importBatch(f.plan, commit()); assert.equal(result.batch.imported, 2); assert.equal(result.batch.skipped, 1);
  assert.deepEqual(result.batch.mapping.map(row => [row.sourceId, row.targetId, row.status]), [[1, 4, 'import'], [2, 4, 'skip'], [3, 5, 'import']]);
  assert.equal(result.batch.mapping[0].targetFileName, result.batch.mapping[1].targetFileName);
  assert.equal((await index(f)).items.length, 5); await assertOldPreserved(f, await index(f));
});

test('unknown collision policy and extra/raw parameters are rejected without writes', async t => {
  const f = await fixture(t), before = await snapshot(f.root);
  for (const collisionPolicy of ['overwrite', 'allocate', '', null, 1, {}, ['allocate-new']]) {
    await rejectCode(f.library.previewBatch(f.plan, { collisionPolicy }), 'INVALID_INPUT');
    await rejectCode(f.library.importBatch(f.plan, { ...commit(), collisionPolicy }), 'INVALID_INPUT');
  }
  await rejectCode(f.library.previewBatch(f.plan, { ...ALLOCATE, path: f.source }), 'INVALID_INPUT');
  await rejectCode(f.library.importBatch(f.plan, { ...commit(), targetId: 1 }), 'INVALID_INPUT');
  await rejectCode(f.library.previewBatch({ ...f.plan }, ALLOCATE), 'INVALID_PLAN');
  assert.deepEqual(await snapshot(f.root), before);
});

for (const phase of ['batch-after-image-install', 'batch-after-index-write']) {
  test(`recovery of allocated derived items at ${phase} protects every preexisting item`, async t => {
    let fired = false;
    const f = await fixture(t, { fault: current => { if (current === phase && !fired) { fired = true; throw Object.assign(new Error('Owned simulated interruption'), { crash: true }); } } });
    const sourceBefore = await snapshot(f.source);
    await assert.rejects(f.library.importBatch(f.plan, commit()), error => error.crash === true);
    const reopened = await f.createLibrary({ fault: undefined }).open(f.root), after = await index(f);
    assert.equal(reopened.revision, phase === 'batch-after-index-write' ? 2 : 1); assert.equal(after.items.length, phase === 'batch-after-index-write' ? 6 : 3);
    await assertOldPreserved(f, after); assert.deepEqual(await snapshot(f.source), sourceBefore);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions')), []);
  });
}

test('manual prompt editing retains and validates the historical derived translation and its provenance', async t => {
  const f = await fixture(t), result = await f.library.importBatch(f.plan, commit()), original = result.items.find(item => item.id === 4);
  const edited = await f.library.update({ id: 4, label: original.label, type: original.type,
    prompts: { en: `${original.prompts.en}\nManual edit`, zh: `${original.prompts.zh}\n手工编辑` }, expectedVersion: 2, expectedRevision: 1 });
  const item = edited.items.find(row => row.id === 4); assert.deepEqual(item.sourceImport, original.sourceImport); assert.deepEqual(item.sourceMetadata, original.sourceMetadata);
  assert.equal(item.sourceImport.derivedChinesePrompt, f.translations[1]);
  assert.equal((await f.createLibrary({ fault: undefined }).open(f.root)).revision, 3);
});

test('tampered persisted translation provenance fails closed without rewriting the changed index', async t => {
  const f = await fixture(t); await f.library.importBatch(f.plan, commit());
  const data = await index(f), item = data.items.find(row => row.id === 4); item.sourceImport.translationProvenance.translatedPromptSha256 = '0'.repeat(64);
  const changed = JSON.stringify(data); await fs.writeFile(path.join(f.root, '.portrait-studio/library.json'), changed);
  await rejectCode(f.createLibrary({ fault: undefined }).open(f.root), 'INVALID_DATA');
  assert.equal(await fs.readFile(path.join(f.root, '.portrait-studio/library.json'), 'utf8'), changed);
});
