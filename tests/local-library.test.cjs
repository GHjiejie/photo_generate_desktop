const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { LocalLibrary } = require('../local-library.cjs');

const originals = require('../assets/selected-prompts.json');
const translations = require('../assets/prompts.zh.json');
const project = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function pngBytes(color = [110, 91, 174, 255]) {
  const png = new PNG({ width: 8, height: 12 });
  for (let index = 0; index < png.data.length; index += 4) png.data.set(color, index);
  return PNG.sync.write(png);
}

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-library-test-'));
  let root = path.join(temporary, 'repository');
  const trash = path.join(temporary, 'trash');
  const source = path.join(temporary, 'portrait.png');
  await fs.mkdir(root);
  root = await fs.realpath(root);
  await fs.mkdir(trash);
  await fs.writeFile(source, pngBytes());
  t.after(async () => {
    // These directories were created by this test and never contain user files.
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.chmod(path.join(root, '.portrait-studio'), 0o700).catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
  });
  let trashSequence = 0;
  const trashItem = async file => {
    const destination = path.join(trash, `${++trashSequence}-${path.basename(file)}`);
    await fs.rename(file, destination);
  };
  const validateImage = async bytes => {
    try { return PNG.sync.read(bytes).width > 0; }
    catch { return false; }
  };
  const createLibrary = additions => new LocalLibrary({ trashItem, validateImage, ...options, ...additions });
  const library = createLibrary();
  const state = await library.open(root);
  return { temporary, root, trash, source, library, state, createLibrary };
}

function payload(state, id = 201, overrides = {}) {
  return {
    id, label: `本地肖像 ${id}`, type: 'photo',
    prompts: { en: `A complete English prompt for portrait ${id}. No lettering.`, zh: `肖像 ${id} 的完整中文提示词。不要文字。` },
    expectedVersion: state.revision, ...overrides,
  };
}

const rejectCode = (action, code) => assert.rejects(action, error => {
  assert.equal(error.code, code, error.stack);
  assert.equal(typeof error.message, 'string');
  assert.ok(error.message.length > 0);
  return true;
});

async function index(root) {
  return JSON.parse(await fs.readFile(path.join(root, '.portrait-studio', 'library.json'), 'utf8'));
}

async function records(root) {
  const directory = path.join(root, '.portrait-studio', 'recovery');
  const names = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result = [];
  for (const name of names) {
    const entry = path.join(directory, name);
    const record = JSON.parse(await fs.readFile(path.join(entry, 'record.json'), 'utf8'));
    result.push({ entry, record, names: await fs.readdir(entry) });
  }
  return result;
}

test('create, edit, image replacement and confirmed deletion persist real files and complete recovery records', async t => {
  const f = await fixture(t);
  assert.equal(f.state.configured, true);
  assert.equal(f.state.writable, true);
  assert.equal(f.state.items.length, 0);
  const originalBytes = await fs.readFile(f.source);
  const created = await f.library.create(payload(f.state), f.source);
  assert.equal(created.items.length, 1);
  assert.ok(created.revision > f.state.revision);
  const { item } = await f.library.get(201);
  assert.deepEqual(item.prompts, payload(f.state).prompts);
  const storedImage = await f.library.imageForId(201);
  assert.equal(path.relative(f.root, storedImage.path).startsWith('..'), false);
  assert.notEqual(storedImage.path, f.source);
  assert.deepEqual(await fs.readFile(storedImage.path), originalBytes);
  const initialIndex = await index(f.root);
  assert.equal(initialIndex.items[0].sha256, digest(originalBytes));
  assert.equal(initialIndex.items[0].size, originalBytes.length);

  const editedPrompts = { en: 'Edited English prompt: 85 mm, eye level; no text.', zh: '编辑后的中文提示词：85 毫米、平视；不要文字。' };
  const edited = await f.library.update(payload(created, 201, {
    label: '编辑后的绘画', type: 'art', prompts: editedPrompts, expectedRevision: item.revision,
  }));
  assert.equal(edited.items[0].label, '编辑后的绘画');
  assert.equal(edited.items[0].type, 'art');
  assert.deepEqual(edited.items[0].prompts, editedPrompts);
  assert.deepEqual(await fs.readFile((await f.library.imageForId(201)).path), originalBytes);

  const replacement = path.join(f.temporary, 'replacement.png');
  const replacementBytes = pngBytes([32, 161, 123, 255]);
  await fs.writeFile(replacement, replacementBytes);
  const replaced = await f.library.update(payload(edited, 201, {
    label: '替换后的绘画', type: 'art', prompts: editedPrompts,
    expectedRevision: edited.items[0].revision,
  }), replacement);
  const latestImage = await f.library.imageForId(201);
  assert.deepEqual(await fs.readFile(latestImage.path), replacementBytes);
  assert.equal((await index(f.root)).items[0].sha256, digest(replacementBytes));
  const removal = { id: 201, expectedVersion: replaced.revision, expectedRevision: replaced.items[0].revision };
  await rejectCode(() => f.library.remove(removal), 'CONFIRMATION_REQUIRED');
  assert.equal((await f.library.list()).items.length, 1);
  assert.deepEqual(await fs.readFile(latestImage.path), replacementBytes);
  const removed = await f.library.remove({ ...removal, confirmed: true });
  assert.deepEqual(removed.items, []);
  await assert.rejects(fs.access(latestImage.path), { code: 'ENOENT' });
  assert.ok((await fs.readdir(f.trash)).length > 0);
  const recovery = await records(f.root);
  const deletion = recovery.find(entry => entry.record.operation === 'remove' && JSON.stringify(entry.record).includes(editedPrompts.en) && JSON.stringify(entry.record).includes(editedPrompts.zh));
  assert.ok(deletion, 'recoverable metadata includes both complete edited prompts');
  const recoveryImage = deletion.names.find(name => /^image\./.test(name));
  assert.ok(recoveryImage, 'a recovery copy accompanies deleted metadata');
  assert.deepEqual(await fs.readFile(path.join(deletion.entry, recoveryImage)), replacementBytes);
  assert.deepEqual((await index(f.root)).items, []);
  const restarted = f.createLibrary();
  assert.deepEqual((await restarted.open(f.root)).items, []);
  assert.equal((await restarted.list()).revision, removed.revision);
  await rejectCode(() => restarted.remove({ ...removal, expectedVersion: removed.revision, confirmed: true }), 'NOT_FOUND');
  assert.deepEqual(await fs.readFile(f.source), originalBytes, 'importing leaves the selected source untouched');
});

test('legacy repository fixture preserves all 13 English, Chinese prompts and source image hashes across reopening', async t => {
  const f = await fixture(t);
  // Read-only original references are copied into the temporary repository.
  // Missing source references may be read from the sealed 1.4 app; code-only
  // distributions skip this optional legacy-image check if neither is present.
  // Never restore references to the user's source assets directory.
  const legacyRoot = path.join(f.temporary, 'legacy-repository');
  const imageDirectory = path.join(legacyRoot, 'assets', 'images');
  await fs.mkdir(imageDirectory, { recursive: true });
  await fs.writeFile(path.join(legacyRoot, 'assets', 'selected-prompts.json'), JSON.stringify(originals));
  await fs.writeFile(path.join(legacyRoot, 'assets', 'prompts.zh.json'), JSON.stringify(translations));
  const hashes = {}, references = {};
  for (const original of originals) {
    let reference = path.join(project, 'assets', 'images', original.image);
    if (!await fs.lstat(reference).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
      reference = path.join(project, 'release/archives/1.4.0/runtime/mac-arm64/Portrait Studio.app/Contents/Resources/portraits', original.image);
      if (!await fs.lstat(reference).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
        t.skip(`原源图 ${original.id} 与已封存参考图均不可用；源码包不携带图库，不恢复素材。`); return;
      }
    }
    references[original.image] = reference;
    const bytes = await fs.readFile(reference);
    hashes[original.image] = digest(bytes);
    await fs.writeFile(path.join(imageDirectory, original.image), bytes);
  }
  const library = f.createLibrary({ validateImage: async () => true });
  const state = await library.open(legacyRoot);
  assert.equal(state.items.length, 13);
  for (const original of originals) {
    const { item } = await library.get(original.id);
    assert.equal(item.prompts.en, original.prompt);
    assert.equal(item.prompts.zh, translations[String(original.id)]);
    assert.equal(digest(await fs.readFile((await library.imageForId(original.id)).path)), hashes[original.image]);
  }
  const reopened = await f.createLibrary({ validateImage: async () => true }).open(legacyRoot);
  assert.equal(reopened.revision, state.revision);
  assert.equal(reopened.items.length, 13);
  for (const original of originals) {
    assert.equal(digest(await fs.readFile(path.join(imageDirectory, original.image))), hashes[original.image]);
    assert.equal(digest(await fs.readFile(references[original.image])), hashes[original.image]);
  }
});

test('invalid metadata, duplicate IDs, bad formats and source symlinks leave the library unchanged', async t => {
  const f = await fixture(t);
  for (const change of [
    { id: '../escape' }, { id: 0 }, { label: '' }, { type: 'unknown' },
    { prompts: { en: '', zh: '中文' } }, { prompts: { en: 'English', zh: '' } },
  ]) {
    await rejectCode(() => f.library.create(payload(f.state, 201, change), f.source), 'INVALID_DATA');
  }
  const malformed = path.join(f.temporary, 'malformed.png');
  await fs.writeFile(malformed, 'not an image');
  await rejectCode(() => f.library.create(payload(f.state), malformed), 'INVALID_IMAGE');
  const unsupported = path.join(f.temporary, 'unsupported.svg');
  await fs.writeFile(unsupported, '<svg xmlns="http://www.w3.org/2000/svg" />');
  await rejectCode(() => f.library.create(payload(f.state), unsupported), 'INVALID_IMAGE');
  const symlink = path.join(f.temporary, 'linked.png');
  await fs.symlink(f.source, symlink);
  await rejectCode(() => f.library.create(payload(f.state), symlink), 'UNSAFE_PATH');
  assert.deepEqual((await f.library.list()).items, []);
  const created = await f.library.create(payload(f.state), f.source);
  await rejectCode(() => f.library.create(payload(created), f.source), 'DUPLICATE_ID');
  assert.equal((await f.library.list()).revision, created.revision);
  assert.equal((await index(f.root)).items.length, 1);
});

test('optimistic collection and item revisions reject stale edits and concurrent writers', async t => {
  const f = await fixture(t);
  const created = await f.library.create(payload(f.state), f.source);
  const current = created.items[0];
  await rejectCode(() => f.library.update(payload(f.state, 201, { expectedRevision: current.revision })), 'CONFLICT');
  await rejectCode(() => f.library.update(payload(created, 201, { expectedRevision: current.revision - 1 })), 'CONFLICT');
  await rejectCode(() => f.library.remove({ id: 201, expectedVersion: f.state.revision, expectedRevision: current.revision, confirmed: true }), 'CONFLICT');
  const concurrent = await Promise.allSettled([
    f.library.create(payload(created, 202), f.source),
    f.library.create(payload(created, 203), f.source),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
  assert.ok(['CONFLICT', 'LIBRARY_BUSY'].includes(concurrent.find(result => result.status === 'rejected').reason.code));
  assert.equal((await index(f.root)).items.length, 2);
  const a = f.createLibrary();
  const b = f.createLibrary();
  const stateA = await a.open(f.root);
  const stateB = await b.open(f.root);
  await a.create(payload(stateA, 204), f.source);
  await rejectCode(() => b.create(payload(stateB, 205), f.source), 'CONFLICT');
  assert.equal((await f.createLibrary().open(f.root)).items.length, 3);
});

test('asset lookup rejects replaced escaping symlinks and metadata directory symlinks', async t => {
  const f = await fixture(t);
  await f.library.create(payload(f.state), f.source);
  const image = await f.library.imageForId(201);
  const bytes = await fs.readFile(image.path);
  await fs.unlink(image.path);
  await fs.symlink(f.source, image.path);
  await rejectCode(() => f.library.imageForId(201), 'UNSAFE_PATH');
  await fs.unlink(image.path);
  await fs.writeFile(image.path, bytes);
  const maliciousRoot = path.join(f.temporary, 'linked-metadata-repository');
  await fs.mkdir(maliciousRoot);
  await fs.symlink(path.join(f.root, '.portrait-studio'), path.join(maliciousRoot, '.portrait-studio'));
  await rejectCode(() => f.createLibrary().open(maliciousRoot), 'UNSAFE_PATH');
});

test('unwritable selected repositories return explicit permission errors without modifying assets', async t => {
  const f = await fixture(t);
  const lockedRoot = path.join(f.temporary, 'read-only-repository');
  await fs.mkdir(lockedRoot);
  await fs.chmod(lockedRoot, 0o555);
  t.after(() => fs.chmod(lockedRoot, 0o700).catch(() => {}));
  await rejectCode(() => f.createLibrary().open(lockedRoot), 'NO_PERMISSION');
  assert.deepEqual(await fs.readdir(lockedRoot), []);
  const state = await f.library.create(payload(f.state), f.source);
  const image = await f.library.imageForId(201);
  const before = await fs.readFile(image.path);
  await fs.chmod(path.join(f.root, '.portrait-studio'), 0o555);
  await rejectCode(() => f.library.update(payload(state, 201, { expectedRevision: state.items[0].revision, label: '不应写入' })), 'NO_PERMISSION');
  await fs.chmod(path.join(f.root, '.portrait-studio'), 0o700);
  assert.equal((await index(f.root)).items[0].label, state.items[0].label);
  assert.deepEqual(await fs.readFile(image.path), before);
});

test('forged payload paths, invalid roots and corrupt indexes are rejected without overwriting external files', async t => {
  const f = await fixture(t);
  await rejectCode(() => f.library.create(payload(f.state, 201, { imageRel: '../outside.png' }), f.source), 'INVALID_DATA');
  await rejectCode(() => f.createLibrary().open('relative/path'), 'INVALID_ROOT');
  await rejectCode(() => f.createLibrary().open('/'), 'INVALID_ROOT');
  const fakeApplication = path.join(f.temporary, 'Unsafe.app');
  await fs.mkdir(fakeApplication);
  await rejectCode(() => f.createLibrary().open(fakeApplication), 'INVALID_ROOT');
  await f.library.create(payload(f.state), f.source);
  const originalImage = await f.library.imageForId(201);
  const beforeBytes = await fs.readFile(originalImage.path);
  const malformed = await index(f.root);
  malformed.items[0].imageRel = '../outside.png';
  const forgedIndex = JSON.stringify(malformed);
  await fs.writeFile(path.join(f.root, '.portrait-studio', 'library.json'), forgedIndex);
  await rejectCode(() => f.createLibrary().open(f.root), 'INVALID_DATA');
  assert.equal(await fs.readFile(path.join(f.root, '.portrait-studio', 'library.json'), 'utf8'), forgedIndex);
  assert.deepEqual(await fs.readFile(originalImage.path), beforeBytes);
  assert.deepEqual(await fs.readFile(f.source), beforeBytes);
});

test('external asset edits produce an explicit conflict without silently replacing the changed bytes', async t => {
  const f = await fixture(t);
  const created = await f.library.create(payload(f.state), f.source);
  const image = await f.library.imageForId(201);
  const changed = pngBytes([208, 80, 84, 255]);
  await fs.writeFile(image.path, changed);
  await rejectCode(() => f.library.list(), 'CONFLICT');
  assert.deepEqual(await fs.readFile(image.path), changed);
  assert.equal((await index(f.root)).revision, created.revision);
});

test('system Trash permission failure preserves the active asset and index', async t => {
  const f = await fixture(t);
  const created = await f.library.create(payload(f.state), f.source);
  const image = await f.library.imageForId(201);
  const before = await fs.readFile(image.path);
  const failing = f.createLibrary({ trashItem: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } });
  await failing.open(f.root);
  await rejectCode(() => failing.remove({ id: 201, expectedVersion: created.revision, expectedRevision: created.items[0].revision, confirmed: true }), 'NO_PERMISSION');
  const reopened = await f.createLibrary().open(f.root);
  assert.equal(reopened.revision, created.revision);
  assert.deepEqual(reopened.items[0].prompts, created.items[0].prompts);
  assert.deepEqual(await fs.readFile(image.path), before);
});

for (const phase of ['after-image-install', 'before-index-write', 'after-index-write']) {
  test(`ordinary create failure at ${phase} rolls back both image and index`, async t => {
    const f = await fixture(t);
    const failing = f.createLibrary({ fault: async observed => { if (observed === phase) throw new Error(`injected ${phase}`); } });
    await failing.open(f.root);
    await assert.rejects(() => failing.create(payload(f.state), f.source));
    const reopened = await f.createLibrary().open(f.root);
    assert.equal(reopened.revision, f.state.revision);
    assert.deepEqual(reopened.items, []);
    assert.deepEqual((await index(f.root)).items, []);
    assert.deepEqual(await fs.readFile(f.source), pngBytes());
  });
}

for (const phase of ['after-image-install', 'before-index-write', 'after-index-write']) {
  test(`ordinary replacement failure at ${phase} restores original bytes and prompts`, async t => {
    const f = await fixture(t);
    const created = await f.library.create(payload(f.state), f.source);
    const image = await f.library.imageForId(201);
    const originalBytes = await fs.readFile(image.path);
    const replacement = path.join(f.temporary, 'replacement.png');
    await fs.writeFile(replacement, pngBytes([22, 194, 44, 255]));
    const failing = f.createLibrary({ fault: async observed => { if (observed === phase) throw new Error(`injected ${phase}`); } });
    await failing.open(f.root);
    await assert.rejects(() => failing.update(payload(created, 201, {
      label: '不应提交的编辑', prompts: { en: 'Uncommitted English', zh: '未提交中文' }, expectedRevision: created.items[0].revision,
    }), replacement));
    const restarted = f.createLibrary();
    const reopened = await restarted.open(f.root);
    assert.equal(reopened.revision, created.revision);
    assert.deepEqual(reopened.items[0].prompts, created.items[0].prompts);
    assert.equal(reopened.items[0].label, created.items[0].label);
    assert.deepEqual(await fs.readFile((await restarted.imageForId(201)).path), originalBytes);
  });
}

for (const phase of ['after-trash', 'before-index-write', 'after-index-write']) {
  test(`ordinary deletion failure at ${phase} restores an image already moved to Trash`, async t => {
    const f = await fixture(t);
    const created = await f.library.create(payload(f.state), f.source);
    const before = await f.library.imageForId(201);
    const beforeBytes = await fs.readFile(before.path);
    const failing = f.createLibrary({ fault: async observed => { if (observed === phase) throw new Error(`injected ${phase}`); } });
    await failing.open(f.root);
    await assert.rejects(() => failing.remove({ id: 201, expectedVersion: created.revision, expectedRevision: created.items[0].revision, confirmed: true }));
    const restarted = f.createLibrary();
    const reopened = await restarted.open(f.root);
    assert.equal(reopened.revision, created.revision);
    assert.equal(reopened.items.length, 1);
    assert.deepEqual(reopened.items[0].prompts, created.items[0].prompts);
    assert.deepEqual(await fs.readFile(before.path), beforeBytes);
    assert.deepEqual(await fs.readFile((await restarted.imageForId(201)).path), beforeBytes);
  });
}

for (const phase of ['after-image-install', 'before-index-write', 'after-index-write']) {
  test(`restart recovers create journal after simulated crash at ${phase}`, async t => {
    const f = await fixture(t);
    const crashing = f.createLibrary({ fault: async observed => { if (observed === phase) throw Object.assign(new Error(`crash ${phase}`), { crash: true }); } });
    await crashing.open(f.root);
    await assert.rejects(() => crashing.create(payload(f.state), f.source));
    const restarted = f.createLibrary();
    const reopened = await restarted.open(f.root);
    const committed = phase === 'after-index-write';
    assert.equal(reopened.items.length, committed ? 1 : 0);
    assert.equal(reopened.revision, f.state.revision + (committed ? 1 : 0));
    if (committed) assert.deepEqual(await fs.readFile((await restarted.imageForId(201)).path), await fs.readFile(f.source));
    assert.deepEqual((await index(f.root)).items.map(item => item.id), reopened.items.map(item => item.id));
  });
}

for (const phase of ['after-trash', 'after-index-write']) {
  test(`restart recovers deletion journal after simulated crash at ${phase}`, async t => {
    const f = await fixture(t);
    const created = await f.library.create(payload(f.state), f.source);
    const before = await f.library.imageForId(201);
    const beforeBytes = await fs.readFile(before.path);
    const crashing = f.createLibrary({ fault: async observed => { if (observed === phase) throw Object.assign(new Error(`crash ${phase}`), { crash: true }); } });
    await crashing.open(f.root);
    await assert.rejects(() => crashing.remove({ id: 201, expectedVersion: created.revision, expectedRevision: created.items[0].revision, confirmed: true }));
    const restarted = f.createLibrary();
    const reopened = await restarted.open(f.root);
    if (phase === 'after-index-write') {
      assert.deepEqual(reopened.items, []);
      await assert.rejects(fs.access(before.path), { code: 'ENOENT' });
      assert.ok((await records(f.root)).some(entry => JSON.stringify(entry.record).includes(created.items[0].prompts.en)));
    } else {
      assert.equal(reopened.items.length, 1);
      assert.equal(reopened.revision, created.revision);
      assert.deepEqual(await fs.readFile(before.path), beforeBytes);
      assert.deepEqual(await fs.readFile((await restarted.imageForId(201)).path), beforeBytes);
    }
  });
}

test('crash recovery retains its journal and refuses to overwrite an independently changed index', async t => {
  const f = await fixture(t);
  const crashing = f.createLibrary({ fault: async phase => {
    if (phase === 'after-image-install') throw Object.assign(new Error('simulated crash'), { crash: true });
  } });
  await crashing.open(f.root);
  await assert.rejects(() => crashing.create(payload(f.state), f.source));
  const externalIndex = await index(f.root);
  externalIndex.revision += 100;
  const externalBytes = JSON.stringify(externalIndex);
  await fs.writeFile(path.join(f.root, '.portrait-studio', 'library.json'), externalBytes);
  await rejectCode(() => f.createLibrary().open(f.root), 'RECOVERY_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.root, '.portrait-studio', 'library.json'), 'utf8'), externalBytes);
  const journals = await fs.readdir(path.join(f.root, '.portrait-studio', 'transactions'));
  assert.equal(journals.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio', 'transactions', journals[0], 'journal.json'), 'utf8')).operation, 'create');
});
