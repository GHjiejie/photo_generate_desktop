'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { PNG } = require('pngjs');
const { createLocalAdapter } = require('../local-electron.cjs');
const { trustedSender } = require('../electron-security.cjs');

const DIRECTORY = 'library-batch-directory-choose';
const PREVIEW = 'library-batch-preview';
const COMMIT = 'library-batch-commit';
const CANCEL = 'library-batch-cancel';
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function image(color = 47) {
  const value = new PNG({ width: 2, height: 3 });
  for (let i = 0; i < value.data.length; i += 4) value.data.set([color, 69, 127, 255], i);
  return PNG.sync.write(value);
}
function record(id = 1) {
  return { id, filename: `${String(id).padStart(3, '0')}-fixture.png`, label: `完整原标签 ${id}`,
    prompt_en: ` Original English ${id}\n  Preserve every character. `,
    prompt_cn: ` 原中文 ${id}\n  保留全部空格、换行与标点。 `,
    original_prompt: `原始字段 ${id}`, nested: { tags: ['无重写', id] } };
}
async function snapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, name), stat = await fs.lstat(absolute), key = path.relative(root, absolute);
      if (stat.isDirectory()) { result[key] = 'directory'; await visit(absolute); }
      else if (stat.isSymbolicLink()) result[key] = `symlink:${await fs.readlink(absolute)}`;
      else result[key] = sha(await fs.readFile(absolute));
    }
  }
  await visit(root); return result;
}
function failed(result, codes) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok([].concat(codes).includes(result.error.code), JSON.stringify(result.error));
  assert.equal(typeof result.error.message, 'string'); assert.ok(result.error.message.trim());
  assert.equal(result.error.message.includes('/private/'), false);
  assert.equal(result.error.message.includes('/Users/'), false);
  return result;
}

async function fixture(t, { nested = false, manifests = 1, records = [record()] } = {}) {
  // Everything exercised here belongs to this test. No real repository,
  // source collection, application instance, clipboard or native dialog runs.
  const requested = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-directory-ipc-'));
  const base = await fs.realpath(requested), root = path.join(base, 'target'), profile = path.join(base, 'profile');
  const source = path.join(base, 'source'), sourceImages = nested ? path.join(source, 'images') : source;
  await fs.mkdir(root); await fs.mkdir(profile); await fs.mkdir(sourceImages, { recursive: true });
  for (const row of records) {
    if (row.filename && !(await fs.lstat(path.join(sourceImages, row.filename)).catch(() => null)))
      await fs.writeFile(path.join(sourceImages, row.filename), image(row.id * 17));
  }
  for (let i = 0; i < manifests; i++) await fs.writeFile(path.join(source, i ? `manifest-${i}.json` : 'manifest.json'), JSON.stringify(records, null, 2) + '\n');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const rendererURL = 'file:///portrait-directory-ipc-test/index.html', frame = { url: rendererURL };
  const sender = { mainFrame: frame }, event = { senderFrame: frame, sender }, handlers = new Map(), dialogs = [], choices = [];
  const adapter = createLocalAdapter({
    app: { isPackaged: true, getPath: () => profile }, defaultRoot: root,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: async (_window, options) => { dialogs.push(options); return choices.shift() || { canceled: true, filePaths: [] }; } },
    shell: { trashItem: () => { throw new Error('Trash must not run in directory IPC tests'); } },
    protocol: { handle: () => {} }, rendererURL, trustedSender,
    nativeImage: { createFromBuffer: bytes => ({ isEmpty: () => !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), getSize: () => ({ width: 2, height: 3 }) }) },
    BrowserWindow: { fromWebContents: () => null }
  });
  const original = process.env.PORTRAIT_STUDIO_LIBRARY_DIR;
  process.env.PORTRAIT_STUDIO_LIBRARY_DIR = root;
  try { await adapter.initialise(); }
  finally { if (original === undefined) delete process.env.PORTRAIT_STUDIO_LIBRARY_DIR; else process.env.PORTRAIT_STUDIO_LIBRARY_DIR = original; }
  const invoke = (channel, ...args) => {
    assert.ok(handlers.has(channel), `Missing fixed handler ${channel}`);
    return handlers.get(channel)(event, ...args);
  };
  const choose = async (directory = source) => {
    choices.push({ canceled: false, filePaths: [directory] });
    return invoke(DIRECTORY);
  };
  const preview = (selection, candidate = selection.manifests[0]?.candidateId) => invoke(PREVIEW, {
    directorySelectionId: selection.selectionId, ...(candidate !== undefined ? { manifestCandidateId: candidate } : {}), type: 'photo'
  });
  return { base, root, profile, source, sourceImages, records, frame, sender, event, handlers, dialogs, choices, invoke, choose, preview };
}

test('preload and adapter expose one directory chooser and no former two-chooser or arbitrary IPC surface', async t => {
  const f = await fixture(t);
  assert.equal(f.handlers.has('library-batch-images-choose'), false);
  assert.equal(f.handlers.has('library-batch-manifest-choose'), false);
  assert.ok(f.handlers.has(DIRECTORY));
  let exposed; const calls = [];
  const source = await fs.readFile(path.join(__dirname, '../preload.js'), 'utf8');
  vm.runInNewContext(source, { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'portraitStudio'); exposed = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } };
  } });
  await exposed.chooseBatchDirectory();
  assert.deepEqual(calls, [[DIRECTORY]]);
  for (const method of ['chooseBatchImages', 'chooseBatchManifest', 'invoke', 'readFile']) assert.equal(Object.hasOwn(exposed, method), false, method);
});

for (const nested of [false, true]) {
  test(`one native directory choice discovers ${nested ? 'root JSON + images subdirectory' : 'root JSON + root images'}, previews without writes and imports exact bilingual copies`, async t => {
    const f = await fixture(t, { nested }), targetBefore = await snapshot(f.root), sourceBefore = await snapshot(f.source);
    const selected = await f.choose(); assert.equal(selected.ok, true, JSON.stringify(selected));
    const selection = selected.data;
    assert.match(selection.selectionId, TOKEN); assert.equal(selection.path, f.source);
    assert.equal(selection.imageCount, 1); assert.equal(selection.manifests.length, 1);
    assert.match(selection.manifests[0].candidateId, TOKEN);
    assert.equal(selection.manifests[0].relativePath, 'manifest.json'); assert.equal(selection.manifests[0].recordCount, 1);
    assert.equal(f.dialogs.length, 1); assert.deepEqual(f.dialogs[0].properties, ['openDirectory']);
    const result = await f.preview(selection); assert.equal(result.ok, true, JSON.stringify(result));
    const preview = result.data; assert.equal(preview.importable, 1); assert.equal(preview.matched, 1); assert.equal(preview.canImport, true);
    assert.deepEqual(await snapshot(f.root), targetBefore); assert.deepEqual(await snapshot(f.source), sourceBefore);
    const imported = await f.invoke(COMMIT, { previewId: preview.previewId, confirmed: true, expectedVersion: preview.revision });
    assert.equal(imported.ok, true, JSON.stringify(imported)); assert.equal(imported.data.report.imported, 1);
    const saved = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/library.json'), 'utf8')).items[0];
    assert.deepEqual(saved.sourceMetadata, f.records[0]);
    assert.equal(saved.prompts.en, f.records[0].prompt_en); assert.equal(saved.prompts.zh, f.records[0].prompt_cn);
    assert.equal(saved.sourceImport.sourceRelativePath, nested ? `images/${f.records[0].filename}` : f.records[0].filename);
    assert.deepEqual(await fs.readFile(path.join(f.root, saved.imageRel)), await fs.readFile(path.join(f.sourceImages, f.records[0].filename)));
    assert.deepEqual(await snapshot(f.source), sourceBefore); assert.equal(f.dialogs.length, 1);
    const after = await snapshot(f.root), repeated = await f.choose();
    const again = await f.preview(repeated.data); assert.equal(again.ok, true);
    assert.equal(again.data.skipped, 1); assert.equal(again.data.importable, 0);
    const repeatedCommit = await f.invoke(COMMIT, { previewId: again.data.previewId, confirmed: true, expectedVersion: again.data.revision });
    assert.equal(repeatedCommit.ok, true, JSON.stringify(repeatedCommit));
    assert.equal(repeatedCommit.data.report.imported, 0); assert.equal(repeatedCommit.data.report.skipped, 1);
    assert.deepEqual(await snapshot(f.root), after); assert.deepEqual(await snapshot(f.source), sourceBefore);
  });
}

test('all batch handlers reject untrusted or child frames before opening a chooser, planning or writing', async t => {
  const f = await fixture(t), selected = await f.choose(), result = await f.preview(selected.data);
  assert.equal(result.ok, true); const preview = result.data;
  const before = await snapshot(f.root), sourceBefore = await snapshot(f.source), dialogsBefore = f.dialogs.length;
  const calls = [[DIRECTORY], [PREVIEW, { directorySelectionId: selected.data.selectionId, manifestCandidateId: selected.data.manifests[0].candidateId, type: 'photo' }],
    [COMMIT, { previewId: preview.previewId, confirmed: true, expectedVersion: preview.revision }], [CANCEL, { directorySelectionId: selected.data.selectionId, previewId: preview.previewId }]];
  for (const event of [{ senderFrame: { url: f.frame.url }, sender: f.sender }, { senderFrame: { url: 'https://example.invalid/' }, sender: f.sender }, { senderFrame: null, sender: f.sender }])
    for (const [channel, ...args] of calls) failed(await f.handlers.get(channel)(event, ...args), 'FORBIDDEN');
  assert.equal(f.dialogs.length, dialogsBefore); assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await snapshot(f.source), sourceBefore);
});

test('forged tokens, raw paths, unexpected properties and cross-selection manifest candidates cannot select files', async t => {
  const f = await fixture(t), first = await f.choose(), second = await f.choose();
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const directorySelectionId = first.data.selectionId, manifestCandidateId = first.data.manifests[0].candidateId;
  const valid = { directorySelectionId, manifestCandidateId, type: 'photo' }, before = await snapshot(f.root);
  for (const value of [null, [], Object.create(null), { ...valid, path: f.source }, { ...valid, manifestPath: path.join(f.source, 'manifest.json') },
    { ...valid, imageDirectory: f.source }, { ...valid, imageSelectionId: directorySelectionId }, { ...valid, type: 'all' }])
    failed(await f.invoke(PREVIEW, value), 'INVALID_INPUT');
  for (const token of [f.source, '../source', 'not-a-token', crypto.randomUUID(), 42, null])
    failed(await f.invoke(PREVIEW, { ...valid, directorySelectionId: token }), 'INVALID_BATCH_SELECTION');
  for (const candidate of [path.join(f.source, 'manifest.json'), 'manifest.json', '../manifest.json', crypto.randomUUID(), second.data.manifests[0].candidateId])
    failed(await f.invoke(PREVIEW, { ...valid, manifestCandidateId: candidate }), 'INVALID_BATCH_SELECTION');
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await f.preview(first.data)).ok, true); assert.equal((await f.preview(second.data)).ok, true);
});

test('cancelling native choice or releasing a batch makes no repository/profile/source writes', async t => {
  const f = await fixture(t), before = await snapshot(f.root), profileBefore = await snapshot(f.profile), sourceBefore = await snapshot(f.source);
  assert.deepEqual(await f.invoke(DIRECTORY), { ok: true, data: { cancelled: true } });
  const chosen = await f.choose(), result = await f.preview(chosen.data); assert.equal(result.ok, true);
  failed(await f.invoke(CANCEL, { directorySelectionId: chosen.data.selectionId, previewId: '/private/forged/path' }), 'INVALID_BATCH_SELECTION');
  assert.equal((await f.preview(chosen.data)).ok, true, 'malformed cancellation must not partially release the valid selection');
  const cancelled = await f.invoke(CANCEL, { directorySelectionId: chosen.data.selectionId, previewId: result.data.previewId });
  assert.equal(cancelled.ok, true); assert.ok(cancelled.data.released >= 2);
  failed(await f.preview(chosen.data), 'INVALID_BATCH_SELECTION');
  failed(await f.invoke(COMMIT, { previewId: result.data.previewId, confirmed: true, expectedVersion: result.data.revision }), 'INVALID_BATCH_SELECTION');
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await snapshot(f.profile), profileBefore); assert.deepEqual(await snapshot(f.source), sourceBefore);
});

test('directory selections and private previews expire without writing or accepting old credentials', async t => {
  const f = await fixture(t), selected = await f.choose(), result = await f.preview(selected.data); assert.equal(result.ok, true);
  const before = await snapshot(f.root), currentTime = Date.now();
  t.mock.method(Date, 'now', () => currentTime + 31 * 60 * 1000);
  failed(await f.preview(selected.data), 'INVALID_BATCH_SELECTION');
  failed(await f.invoke(COMMIT, { previewId: result.data.previewId, confirmed: true, expectedVersion: result.data.revision }), 'INVALID_BATCH_SELECTION');
  assert.deepEqual(await snapshot(f.root), before);
});

test('private preview commit requires explicit confirmation and the previewed destination version', async t => {
  const f = await fixture(t), selected = await f.choose(), result = await f.preview(selected.data); assert.equal(result.ok, true);
  const preview = result.data, before = await snapshot(f.root), sourceBefore = await snapshot(f.source);
  const valid = { previewId: preview.previewId, confirmed: true, expectedVersion: preview.revision };
  for (const confirmed of [undefined, false, 1, 'true']) failed(await f.invoke(COMMIT, { ...valid, confirmed }), 'CONFIRMATION_REQUIRED');
  for (const expectedVersion of [undefined, preview.revision + 1, String(preview.revision)]) failed(await f.invoke(COMMIT, { ...valid, expectedVersion }), 'CONFLICT');
  for (const previewId of [f.source, crypto.randomUUID(), null]) failed(await f.invoke(COMMIT, { ...valid, previewId }), 'INVALID_BATCH_SELECTION');
  failed(await f.invoke(COMMIT, { ...valid, manifestPath: path.join(f.source, 'manifest.json') }), 'INVALID_INPUT');
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await snapshot(f.source), sourceBefore);
  const committed = await f.invoke(COMMIT, valid); assert.equal(committed.ok, true); assert.equal(committed.data.report.imported, 1);
  failed(await f.invoke(COMMIT, valid), 'INVALID_BATCH_SELECTION');
  assert.deepEqual(await snapshot(f.source), sourceBefore);
});

test('switching the destination library invalidates directory credentials and previews for the previous generation', async t => {
  const f = await fixture(t), selected = await f.choose(), result = await f.preview(selected.data); assert.equal(result.ok, true);
  const before = await snapshot(f.root), sourceBefore = await snapshot(f.source), secondRoot = path.join(f.base, 'second-target');
  await fs.mkdir(secondRoot); f.choices.push({ canceled: false, filePaths: [secondRoot] });
  assert.equal((await f.invoke('library-choose')).ok, true);
  const nextBefore = await snapshot(secondRoot);
  failed(await f.preview(selected.data), 'INVALID_BATCH_SELECTION');
  failed(await f.invoke(COMMIT, { previewId: result.data.previewId, confirmed: true, expectedVersion: result.data.revision }), 'INVALID_BATCH_SELECTION');
  assert.deepEqual(await snapshot(f.root), before); assert.deepEqual(await snapshot(secondRoot), nextBefore); assert.deepEqual(await snapshot(f.source), sourceBefore);
});

test('missing JSON gives a recoverable error and multiple manifests require an explicit discovered candidate', async t => {
  const empty = await fixture(t, { manifests: 0 }), emptyBefore = await snapshot(empty.root);
  failed(await empty.choose(), 'NO_MANIFEST'); assert.deepEqual(await snapshot(empty.root), emptyBefore);
  const f = await fixture(t, { manifests: 2 }), before = await snapshot(f.root), selected = await f.choose();
  assert.equal(selected.ok, true); assert.equal(selected.data.manifests.length, 2);
  failed(await f.preview(selected.data, null), ['INVALID_BATCH_SELECTION', 'MANIFEST_SELECTION_REQUIRED']);
  failed(await f.invoke(PREVIEW, { directorySelectionId: selected.data.selectionId, type: 'photo' }), 'MANIFEST_SELECTION_REQUIRED');
  for (const candidate of selected.data.manifests) assert.equal((await f.preview(selected.data, candidate.candidateId)).ok, true);
  assert.equal(f.dialogs.length, 1, 'candidate selection must not open another file chooser'); assert.deepEqual(await snapshot(f.root), before);
});

for (const change of ['directory', 'manifest-before-preview', 'manifest-before-commit', 'image-before-commit']) {
  test(`${change} replacement invalidates the pinned source and never writes target files`, async t => {
    const f = await fixture(t), chosen = await f.choose(); assert.equal(chosen.ok, true);
    const before = await snapshot(f.root);
    let result;
    if (change.endsWith('commit')) { result = await f.preview(chosen.data); assert.equal(result.ok, true); }
    if (change === 'directory') {
      await fs.rename(f.source, `${f.source}-old`); await fs.mkdir(f.source);
      await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify(f.records));
      await fs.writeFile(path.join(f.source, f.records[0].filename), image());
    } else if (change.startsWith('manifest')) await fs.writeFile(path.join(f.source, 'manifest.json'), JSON.stringify([{ ...f.records[0], prompt_en: 'Changed after selecting the directory' }]) + '\n');
    else await fs.writeFile(path.join(f.sourceImages, f.records[0].filename), image(199));
    if (result) failed(await f.invoke(COMMIT, { previewId: result.data.previewId, confirmed: true, expectedVersion: result.data.revision }), ['CONFLICT', 'SOURCE_CHANGED']);
    else failed(await f.preview(chosen.data), ['CONFLICT', 'SOURCE_CHANGED']);
    assert.deepEqual(await snapshot(f.root), before);
  });
}

test('native directory selection rejects a symlink instead of following an alternate source', async t => {
  const f = await fixture(t), link = path.join(f.base, 'source-link'), before = await snapshot(f.root);
  await fs.symlink(f.source, link, 'dir');
  failed(await f.choose(link), ['INVALID_BATCH_SELECTION', 'UNSAFE_PATH', 'INVALID_SOURCE']);
  assert.deepEqual(await snapshot(f.root), before);
});
