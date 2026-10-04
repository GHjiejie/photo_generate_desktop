const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { LocalLibrary } = require('../local-library.cjs');
const { prepareBatchImport } = require('../batch-import.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const decode = bytes => { try { return PNG.sync.read(bytes).width > 0; } catch { return false; } };
function png(color) {
  const image = new PNG({ width: 8, height: 12 });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([color, 41, 127, 255], i);
  return PNG.sync.write(image);
}
function rawRecord(id) {
  return { id, label: `完整肖像 ${id}`, filename: `${String(id).padStart(3, '0')}_portrait.png`, prompt_en: `Full English prompt ${id}.\nKeep every character and punctuation.`, prompt_cn: `完整中文提示词 ${id}。\n保留换行与标点。`, original_prompt: `archive ${id}`, description: '原始说明', category: 'art', seed: 9876 + id, tags: ['portrait', '无重写'], extra: { license: 'fixture', nested: ['原字段', id] } };
}
async function setup(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-batch-test-'));
  const base = await fs.realpath(temporary);
  const root = path.join(base, 'repository'), source = path.join(base, 'images'), trash = path.join(base, 'trash');
  await fs.mkdir(root); await fs.mkdir(source); await fs.mkdir(trash);
  const manifestPath = path.join(base, 'records.json');
  const records = [rawRecord(3), rawRecord(1), rawRecord(2)];
  async function writeManifest(values = records) {
    await fs.writeFile(manifestPath, ` \n${JSON.stringify(values, null, 3)}\n\n`);
    for (const item of values) {
      const filename = item.filename;
      if (filename && !await fs.lstat(path.join(source, filename)).catch(() => null)) await fs.writeFile(path.join(source, filename), png(item.id * 20));
    }
    return prepareBatchImport({ imageDirectory: source, manifestPath, type: 'photo', validateImage: decode });
  }
  const plan = await writeManifest();
  let trashId = 0;
  const createLibrary = additions => new LocalLibrary({ validateImage: decode, trashItem: file => fs.rename(file, path.join(trash, `${++trashId}-${path.basename(file)}`)), ...options, ...additions });
  const library = createLibrary();
  const state = await library.open(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root, source, manifestPath, records, plan, library, state, createLibrary, writeManifest };
}
const rejectCode = (action, code) => assert.rejects(action, error => { assert.equal(error.code, code, error.stack); return true; });
async function index(f) { return JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/library.json'), 'utf8')); }
async function imports(f) { return fs.readdir(path.join(f.root, '.portrait-studio/imports')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }); }
async function snapshot(directory) {
  const result = {};
  async function visit(current) {
    for (const name of (await fs.readdir(current)).sort()) {
      const absolute = path.join(current, name), stat = await fs.lstat(absolute), key = path.relative(directory, absolute);
      if (stat.isDirectory()) { result[key] = 'directory'; await visit(absolute); }
      else result[key] = sha(await fs.readFile(absolute));
    }
  }
  await visit(directory); return result;
}

test('preview preserves repository/source bytes and does not create archives or transactions', async t => {
  const f = await setup(t), before = await snapshot(f.root), sources = await snapshot(f.source);
  const preview = await f.library.previewBatch(f.plan);
  assert.deepEqual(preview.summary, { total: 3, importable: 3, skipped: 0, conflicts: 0, invalid: 0 });
  assert.equal(preview.revision, 1); assert.equal(preview.canImport, true);
  assert.deepEqual(preview.records.map(row => row.recordIndex), [0, 1, 2]);
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await snapshot(f.source), sources);
});

test('one index revision imports real copies, source types and all eleven raw fields with exact JSON archive', async t => {
  const f = await setup(t), sources = await snapshot(f.source), manifest = await fs.readFile(f.manifestPath);
  const result = await f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true });
  assert.equal(result.revision, 2); assert.equal(result.batch.imported, 3);
  assert.deepEqual(result.items.map(item => item.id), [1, 2, 3]);
  for (const item of (await index(f)).items) {
    const raw = f.records.find(record => record.id === item.id);
    assert.equal(item.type, 'art'); // IDs 1 and 3 used to belong to the legacy PHOTO_IDS set.
    assert.deepEqual(item.sourceMetadata, raw); assert.equal(Object.keys(item.sourceMetadata).length, 11);
    assert.equal(item.prompts.en, raw.prompt_en); assert.equal(item.prompts.zh, raw.prompt_cn);
    const bytes = await fs.readFile(path.join(f.root, item.imageRel));
    assert.equal(sha(bytes), item.sourceImport.sourceHash); assert.equal(item.sourceImport.sourceHash, item.sha256);
    assert.deepEqual(bytes, await fs.readFile(path.join(f.source, raw.filename)));
    assert.match(item.image, new RegExp(`^${String(item.id).padStart(6, '0')}-${result.batch.batchId}\\.png$`));
  }
  assert.deepEqual(await fs.readFile(path.join(f.root, result.batch.archiveRel, 'manifest.json')), manifest);
  for (const name of ['source.json', 'mapping.json', 'report.json']) assert.doesNotThrow(() => JSON.parse(require('node:fs').readFileSync(path.join(f.root, result.batch.archiveRel, name), 'utf8')));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, result.batch.archiveRel, 'report.json'), 'utf8')).status, 'completed');
  assert.deepEqual(await snapshot(f.source), sources);
  assert.equal((await f.createLibrary().open(f.root)).items.length, 3);
});

test('repeat import is idempotent and leaves all bytes/revision/archive counts unchanged', async t => {
  const f = await setup(t);
  const first = await f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), before = await snapshot(f.root);
  const preview = await f.library.previewBatch(f.plan);
  assert.equal(preview.summary.skipped, 3); assert.equal(preview.canImport, false);
  const repeat = await f.library.importBatch(f.plan, { expectedVersion: 2, confirmed: true });
  assert.equal(repeat.revision, 2); assert.equal(repeat.batch.imported, 0); assert.equal(repeat.batch.skipped, 3);
  assert.equal(repeat.batch.archiveRel, first.batch.archiveRel);
  assert.deepEqual(await snapshot(f.root), before); assert.equal((await imports(f)).length, 1);
});

test('mixed repeat/conflict/unique entries preserve existing items and import only unique IDs once', async t => {
  const f = await setup(t);
  const first = await f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true });
  const rows = [f.records[1], { ...f.records[2], prompt_en: 'Different English must not overwrite' }, rawRecord(8)];
  const plan = await f.writeManifest(rows), preview = await f.library.previewBatch(plan);
  assert.deepEqual(preview.records.map(row => row.status), ['skip', 'conflict', 'import']);
  const result = await f.library.importBatch(plan, { expectedVersion: 2, confirmed: true });
  assert.equal(result.revision, 3); assert.equal(result.batch.imported, 1); assert.equal(result.batch.skipped, 1); assert.equal(result.batch.conflicts, 1);
  assert.deepEqual(result.items.filter(item => item.id < 8), first.items);
});

test('all-conflict batch produces no writes and confirmation/CAS guard prevent mutations', async t => {
  const f = await setup(t);
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1 }), 'CONFIRMATION_REQUIRED');
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 3, confirmed: true }), 'CONFLICT');
  await f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true });
  const changed = await f.writeManifest(f.records.map(record => ({ ...record, label: `${record.label} 改动` }))), before = await snapshot(f.root);
  const result = await f.library.importBatch(changed, { expectedVersion: 2, confirmed: true });
  assert.equal(result.batch.conflicts, 3); assert.equal(result.batch.imported, 0); assert.deepEqual(await snapshot(f.root), before);
});

for (const phase of ['batch-after-image-install', 'batch-before-index-write', 'batch-after-index-write']) {
  test(`ordinary failure ${phase} rolls back whole batch and retains accurate archive evidence`, async t => {
    let fired = false;
    const f = await setup(t, { fault: current => { if (current === phase && !fired) { fired = true; throw new Error('Injected failure'); } } });
    const source = await snapshot(f.source);
    await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), 'IO_ERROR');
    const result = await f.library.list();
    assert.equal(result.revision, 1); assert.equal(result.items.length, 0); assert.deepEqual(await fs.readdir(path.join(f.root, 'assets/images')), []);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions')), []);
    const archives = await imports(f); assert.equal(archives.length, 1);
    const report = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/imports', archives[0], 'report.json'), 'utf8'));
    assert.equal(report.status, 'rolled-back'); assert.equal(report.imported, 0); assert.deepEqual(await snapshot(f.source), source);
  });
}

for (const phase of ['batch-after-archive', 'batch-after-image-install', 'batch-after-index-write']) {
  test(`restart recovers simulated interruption ${phase} using the independent journal`, async t => {
    let fired = false;
    const f = await setup(t, { fault: current => { if (current === phase && !fired) { fired = true; throw Object.assign(new Error('Simulated crash'), { crash: true }); } } });
    await assert.rejects(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), error => error.crash === true);
    const result = await f.createLibrary({ fault: undefined }).open(f.root);
    assert.equal(result.items.length, phase === 'batch-after-index-write' ? 3 : 0);
    assert.equal(result.revision, phase === 'batch-after-index-write' ? 2 : 1);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions')), []);
  });
}

test('external index edits during staging are preserved without overwriting or deleting copied evidence', async t => {
  let f, externalRaw;
  f = await setup(t, { fault: async phase => {
    if (phase !== 'batch-before-index-write') return;
    const changed = await index(f); changed.updatedAt = 'external-edit';
    externalRaw = JSON.stringify(changed);
    await fs.writeFile(path.join(f.root, '.portrait-studio/library.json'), externalRaw);
  } });
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), 'RECOVERY_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.root, '.portrait-studio/library.json'), 'utf8'), externalRaw);
  assert.equal((await fs.readdir(path.join(f.root, 'assets/images'))).length, 3);
  assert.equal((await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions'))).length, 1);
});

test('abandoned empty journal preparation can recover without touching foreign files', async t => {
  const f = await setup(t), txId = crypto.randomUUID();
  const transactions = path.join(f.root, '.portrait-studio/batch-transactions');
  await fs.mkdir(transactions); await fs.mkdir(path.join(transactions, txId));
  const state = await f.createLibrary().open(f.root);
  assert.equal(state.revision, 1); assert.equal(state.items.length, 0);
  assert.deepEqual(await fs.readdir(transactions), []);
});

test('source change after staging aborts before commit, preserving the changed source and no library additions', async t => {
  let f, fired = false;
  f = await setup(t, { fault: async phase => { if (phase === 'batch-before-index-write' && !fired) { fired = true; await fs.writeFile(f.plan.records[0].sourceImagePath, png(199)); } } });
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), 'SOURCE_CHANGED');
  assert.equal((await f.library.list()).items.length, 0);
  assert.deepEqual(await fs.readFile(f.plan.records[0].sourceImagePath), png(199));
});

test('abort before the index commit rolls back staged copies and leaves old revision', async t => {
  const controller = new AbortController();
  const f = await setup(t, { fault: phase => { if (phase === 'batch-before-index-write') controller.abort(); } });
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true, signal: controller.signal }), 'ABORTED');
  assert.equal((await f.library.list()).revision, 1); assert.deepEqual(await fs.readdir(path.join(f.root, 'assets/images')), []);
});

test('external replacement of a new copied inode is preserved and recovery fails closed', async t => {
  let f, external, fired = false;
  f = await setup(t, { fault: async phase => {
    if (phase !== 'batch-after-image-install' || fired) return;
    fired = true;
    const names = await fs.readdir(path.join(f.root, 'assets/images'));
    external = path.join(f.root, 'assets/images', names[0]);
    await fs.unlink(external); await fs.writeFile(external, png(222));
    throw new Error('Stop after external replacement');
  } });
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), 'RECOVERY_CONFLICT');
  assert.deepEqual(await fs.readFile(external), png(222)); assert.equal((await index(f)).revision, 1);
  await rejectCode(f.createLibrary().open(f.root), 'RECOVERY_CONFLICT');
});

test('ordinary edit, image replacement and Trash recovery retain complete original source metadata', async t => {
  const f = await setup(t);
  const batch = await f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), original = batch.items[0];
  const edit = { id: original.id, label: '人工更名', type: 'photo', prompts: { ...original.prompts, zh: `${original.prompts.zh}\n人工编辑` }, expectedVersion: 2, expectedRevision: 1 };
  const edited = await f.library.update(edit);
  assert.deepEqual(edited.items[0].sourceMetadata, original.sourceMetadata); assert.deepEqual(edited.items[0].sourceImport, original.sourceImport);
  const replacement = path.join(f.base, 'replacement.png'); await fs.writeFile(replacement, png(188));
  const replaced = await f.library.update({ ...edit, expectedVersion: 3, expectedRevision: 2 }, replacement);
  assert.deepEqual(replaced.items[0].sourceMetadata, original.sourceMetadata);
  await f.library.remove({ id: original.id, expectedVersion: 4, expectedRevision: 3, confirmed: true });
  for (const id of await fs.readdir(path.join(f.root, '.portrait-studio/recovery'))) {
    const record = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/recovery', id, 'record.json'), 'utf8'));
    assert.deepEqual(record.item.sourceMetadata, original.sourceMetadata); assert.deepEqual(record.item.sourceImport, original.sourceImport);
  }
});

test('partial invalid manifest records remain exact in archive and are reported rather than translated', async t => {
  const f = await setup(t);
  const rows = [f.records[0], { ...f.records[1], prompt_cn: '' }], plan = await f.writeManifest(rows);
  const preview = await f.library.previewBatch(plan);
  assert.equal(preview.summary.importable, 1); assert.equal(preview.summary.invalid, 1);
  const result = await f.library.importBatch(plan, { expectedVersion: 1, confirmed: true });
  assert.equal(result.batch.imported, 1); assert.equal(result.batch.invalid, 1);
  assert.deepEqual(await fs.readFile(path.join(f.root, result.batch.archiveRel, 'manifest.json')), await fs.readFile(f.manifestPath));
});

test('untrusted/capped plan, modified raw bytes and source inode changes are rejected before writes', async t => {
  const f = await setup(t), before = await snapshot(f.root);
  await rejectCode(f.library.previewBatch({ ...f.plan, records: Array(501).fill(f.plan.records[0]) }), 'INVALID_DATA');
  await rejectCode(f.library.previewBatch({ ...f.plan }), 'INVALID_PLAN');
  const source = f.plan.records[0].sourceImagePath, bytes = await fs.readFile(source);
  await fs.rename(source, `${source}.old`); await fs.writeFile(source, bytes);
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), 'SOURCE_CHANGED');
  assert.deepEqual(await snapshot(f.root), before);
});

test('raw JSON Buffer mutation invalidates authorization even when source disk bytes are unchanged', async t => {
  const f = await setup(t), before = await snapshot(f.root);
  f.plan.manifestBytes[0] = 0;
  await rejectCode(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), 'INVALID_DATA');
  assert.deepEqual(await snapshot(f.root), before);
});

for (const phase of ['batch-after-stage-create', 'batch-before-stage-write', 'batch-during-stage-write', 'batch-after-stage-write']) {
  test(`exact stage interruption ${phase} reopens the old library and preserves unproven partial files`, async t => {
    let fired = false;
    const f = await setup(t, { fault: current => { if (current === phase && !fired) { fired = true; throw Object.assign(new Error('Exact creation/write gap'), { crash: true }); } } });
    await assert.rejects(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), error => error.crash);
    const [txId] = await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions'));
    const journal = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/batch-transactions', txId, 'journal.json'), 'utf8'));
    const entry = journal.entries[0], stage = path.join(f.root, entry.stageRel), stat = await fs.lstat(stage);
    if (phase === 'batch-after-stage-create') assert.equal(entry.identity, null);
    else assert.deepEqual(entry.identity, { dev: stat.dev, ino: stat.ino });
    assert.equal(entry.ready, false);
    const partialBytes = await fs.readFile(stage);
    const result = await f.createLibrary({ fault: undefined }).open(f.root);
    assert.equal(result.revision, 1); assert.equal(result.items.length, 0);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions')), []);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'assets/images')), []);
    if (phase === 'batch-after-stage-write') await assert.rejects(fs.lstat(stage), { code: 'ENOENT' });
    else assert.deepEqual(await fs.readFile(stage), partialBytes);
    assert.equal((await f.createLibrary({ fault: undefined }).open(f.root)).revision, 1);
  });
}

test('partial second stage recovers all live first copies while retaining the incomplete unpublished second file', async t => {
  let count = 0;
  const f = await setup(t, { fault: phase => { if (phase === 'batch-during-stage-write' && ++count === 2) throw Object.assign(new Error('Second partial copy'), { crash: true }); } });
  await assert.rejects(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), error => error.crash);
  const [txId] = await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions'));
  const journal = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/batch-transactions', txId, 'journal.json'), 'utf8'));
  const incomplete = path.join(f.root, journal.entries[1].stageRel), bytes = await fs.readFile(incomplete);
  assert.equal((await fs.readdir(path.join(f.root, 'assets/images'))).length, 1);
  const result = await f.createLibrary({ fault: undefined }).open(f.root);
  assert.equal(result.revision, 1); assert.deepEqual(await fs.readdir(path.join(f.root, 'assets/images')), []);
  assert.deepEqual(await fs.readFile(incomplete), bytes);
  assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions')), []);
});

for (const phase of ['batch-after-manifest-create', 'batch-during-manifest-write', 'batch-after-manifest-write']) {
  test(`raw manifest interruption ${phase} keeps incomplete evidence without blocking library restart`, async t => {
    const f = await setup(t, { fault: current => { if (current === phase) throw Object.assign(new Error('Raw manifest write gap'), { crash: true }); } });
    await assert.rejects(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), error => error.crash);
    const [txId] = await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions'));
    const journal = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/batch-transactions', txId, 'journal.json'), 'utf8'));
    assert.equal(journal.archiveReady, false); assert.equal(journal.entries.every(entry => entry.identity === null), true);
    const manifest = path.join(f.root, journal.archiveRel, 'manifest.json'), before = await fs.readFile(manifest);
    const result = await f.createLibrary({ fault: undefined }).open(f.root);
    assert.equal(result.revision, 1); assert.equal(result.items.length, 0); assert.deepEqual(await fs.readFile(manifest), before);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions')), []);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'assets/images')), []);
  });
}

test('an externally replaced unpublished stage is retained without deleting it or blocking the unchanged library', async t => {
  const f = await setup(t, { fault: phase => { if (phase === 'batch-after-stage-create') throw Object.assign(new Error('Create gap'), { crash: true }); } });
  await assert.rejects(f.library.importBatch(f.plan, { expectedVersion: 1, confirmed: true }), error => error.crash);
  const [txId] = await fs.readdir(path.join(f.root, '.portrait-studio/batch-transactions'));
  const journal = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/batch-transactions', txId, 'journal.json'), 'utf8'));
  const stage = path.join(f.root, journal.entries[0].stageRel);
  await fs.unlink(stage); await fs.writeFile(stage, 'External unpublished file: retain me');
  const result = await f.createLibrary({ fault: undefined }).open(f.root);
  assert.equal(result.revision, 1); assert.equal(await fs.readFile(stage, 'utf8'), 'External unpublished file: retain me');
});
