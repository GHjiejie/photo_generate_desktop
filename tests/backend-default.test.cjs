'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PNG } = require('pngjs');
const { createLocalAdapter } = require('../local-electron.cjs');
const { trustedSender } = require('../electron-security.cjs');

async function mainFixture(env = {}, isPackaged = false) {
  const source = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8');
  const loaded = [], windows = [], events = new Map(), handlers = new Map(), operations = [];
  const defaults = { version: 1, root: '/external/owned-photo_repo', legacyRoot: '/external/legacy-project' };
  const app = { isPackaged, whenReady: () => Promise.resolve(), on: (name, handler) => events.set(name, handler), setPath: (...args) => operations.push(['profile', ...args]), quit: () => operations.push(['quit']) };
  class Window {
    constructor(options) { windows.push(options); this.webContents = { setWindowOpenHandler() {}, on() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }; }
    loadFile() {}
  }
  const adapter = { initialise: async () => operations.push(['initialise']), dispose: async () => operations.push(['dispose']), imageToOpen: async () => null };
  let selected, options;
  const factory = name => value => { selected = name; options = value; operations.push(['factory', name]); return adapter; };
  vm.runInNewContext(source, { __dirname: '/owned-source-project', process: { env, platform: 'darwin' }, require: name => {
    loaded.push(name);
    if (name === 'electron') return { app, BrowserWindow: Window, clipboard: { writeText() {} }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, shell: {}, dialog: {}, nativeImage: {}, protocol: { registerSchemesAsPrivileged() {} } };
    if (name === './local-electron.cjs') return { createLocalAdapter: factory('local') };
    if (name === './remote-electron.cjs') return { createRemoteAdapter: factory('remote') };
    if (name === './assets/default-library.json') return defaults;
    if (name === './electron-security.cjs') return { trustedSender };
    if (name === 'node:fs') return { mkdirSync: (...args) => operations.push(['mkdir', ...args]), realpathSync: value => value };
    return require(name);
  } });
  await new Promise(resolve => setImmediate(resolve));
  return { selected, options, loaded, windows, events, operations, defaults };
}

for (const mode of [undefined, '', 'local', 'REMOTE', 'unexpected']) {
  test(`main defaults to local for backend ${String(mode)} despite remote address or credentials`, async () => {
    const env = { PORTRAIT_STUDIO_REMOTE_BASE_URL: 'https://unused.invalid/', PORTRAIT_STUDIO_REMOTE_AUTHORIZATION: 'unused test value' };
    if (mode !== undefined) env.PORTRAIT_STUDIO_BACKEND = mode;
    const f = await mainFixture(env); assert.equal(f.selected, 'local'); assert.equal(f.loaded.includes('./remote-electron.cjs'), false);
    assert.equal(f.options.sourceRoot, '/owned-source-project/photo_repo'); assert.equal(f.options.defaultRoot, f.options.sourceRoot);
    assert.deepEqual(Array.from(f.windows[0].webPreferences.additionalArguments), ['--portrait-studio-backend=local']);
    assert.equal(f.windows[0].webPreferences.sandbox, true); assert.equal(f.windows[0].webPreferences.contextIsolation, true); assert.equal(f.windows[0].webPreferences.nodeIntegration, false);
  });
}

test('only explicit remote backend loads the remote adapter and exposes the pinned remote mode', async () => {
  const f = await mainFixture({ PORTRAIT_STUDIO_BACKEND: 'remote' }); assert.equal(f.selected, 'remote');
  assert.equal(f.loaded.includes('./local-electron.cjs'), false); assert.equal(f.loaded.includes('./assets/default-library.json'), false);
  assert.deepEqual(Array.from(f.windows[0].webPreferences.additionalArguments), ['--portrait-studio-backend=remote']);
});

test('packaged local defaults remain external and preserve the exact legacy root migration contract', async () => {
  const f = await mainFixture({}, true); assert.equal(f.selected, 'local'); assert.equal(f.options.defaultRoot, f.defaults.root); assert.equal(f.options.legacyRoot, f.defaults.legacyRoot);
  assert.equal(f.options.defaultRoot.includes('.asar'), false); assert.equal(f.options.defaultRoot.includes('.app'), false);
});

test('packaged builds stay local even with an explicit source-only remote override', async () => {
  const f = await mainFixture({ PORTRAIT_STUDIO_BACKEND: 'remote', PORTRAIT_STUDIO_REMOTE_BASE_URL: 'https://unused.invalid/', PORTRAIT_STUDIO_REMOTE_AUTHORIZATION: 'unused test value' }, true);
  assert.equal(f.selected, 'local');
  assert.equal(f.loaded.includes('./remote-electron.cjs'), false);
  assert.equal(f.options.defaultRoot, f.defaults.root);
  assert.deepEqual(Array.from(f.windows[0].webPreferences.additionalArguments), ['--portrait-studio-backend=local']);
});

test('main configures only the selected profile before constructing the adapter, and awaits its local disposal', async () => {
  const f = await mainFixture({ PORTRAIT_STUDIO_USER_DATA_DIR: '/owned-temp-profile' });
  assert.ok(f.operations.findIndex(row => row[0] === 'profile') < f.operations.findIndex(row => row[0] === 'factory'));
  let prevented = false; f.events.get('before-quit')({ preventDefault: () => { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(prevented, true);
  assert.deepEqual(f.operations.slice(-2), [['dispose'], ['quit']]);
});

async function localFixture(t, { saved = null } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-default-local-')));
  const root = path.join(base, 'photo_repo'), profile = path.join(base, 'profile'), custom = path.join(base, 'custom-library'), legacy = path.join(base, 'legacy-project');
  await Promise.all([root, profile, custom].map(value => fs.mkdir(value)));
  if (saved) await fs.writeFile(path.join(profile, 'library-config.json'), JSON.stringify({ version: 1, root: saved === 'legacy' ? legacy : custom }) + '\n');
  const png = new PNG({ width: 2, height: 3 }); png.data.fill(128); const bytes = PNG.sync.write(png), sourceImage = path.join(base, 'selected.png'); await fs.writeFile(sourceImage, bytes);
  const handlers = new Map(), choices = [], copies = [];
  const rendererURL = 'file:///owned-local-renderer/index.html', frame = { url: rendererURL }, event = { senderFrame: frame, sender: { mainFrame: frame } };
  let media, trashAction = filename => fs.unlink(filename);
  const adapter = createLocalAdapter({ app: { isPackaged: true, getPath: () => profile }, sourceRoot: root, defaultRoot: root, legacyRoot: legacy, rendererURL, trustedSender,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, protocol: { handle: (_name, handler) => { media = handler; } },
    dialog: { showOpenDialog: async () => choices.shift() || { canceled: true, filePaths: [] } }, BrowserWindow: { fromWebContents: () => null },
    shell: { trashItem: filename => trashAction(filename) }, clipboard: { writeText: value => copies.push(value) },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 3 }) }) } });
  const before = process.env.PORTRAIT_STUDIO_LIBRARY_DIR; delete process.env.PORTRAIT_STUDIO_LIBRARY_DIR;
  try { await adapter.initialise(); } finally { if (before !== undefined) process.env.PORTRAIT_STUDIO_LIBRARY_DIR = before; }
  t.after(async () => { await adapter.dispose(); await fs.rm(base, { recursive: true, force: true }); });
  return { root, profile, custom, legacy, sourceImage, bytes, adapter, handlers, event, choices, copies, setTrash: action => { trashAction = action; }, media: value => media(value), invoke: (name, ...args) => handlers.get(name)(event, ...args) };
}

test('the actual local adapter supports CRUD, complete bilingual copying and verified images without address or login', async t => {
  const f = await localFixture(t), initial = (await f.invoke('library-list')).data;
  assert.equal(initial.backend, 'local'); assert.equal(initial.remote, false); assert.equal(initial.root, f.root); assert.equal(initial.configured, true); assert.equal(initial.writable, true);
  const settings = (await f.invoke('library-connection-settings')).data; assert.equal(settings.status, 'local'); assert.equal(settings.authentication, null); assert.equal(settings.endpoint, '');
  f.choices.push({ canceled: false, filePaths: [f.sourceImage] }); const picked = (await f.invoke('library-image-choose')).data;
  const prompts = { en: ' Whole English\n  Keep every space. ', zh: ' 完整中文\n  保留每个空格。 ' };
  const created = await f.invoke('library-create', { id: 101, label: 'owned local fixture', type: 'photo', prompts, expectedVersion: initial.revision, imageToken: picked.token }); assert.equal(created.ok, true, JSON.stringify(created));
  const value = created.data.items[0]; assert.deepEqual(value.prompts, prompts);
  for (const language of ['en', 'zh']) assert.equal(await f.invoke('copy-prompt', { id: 101, revision: value.revision, language }), true);
  assert.deepEqual(f.copies, [prompts.en, prompts.zh]); assert.equal(await f.invoke('copy-prompt', { id: 101, revision: value.revision + 1, language: 'en' }), false);
  const response = await f.media({ method: 'GET', url: value.image_url }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  assert.equal((await f.media({ method: 'GET', url: value.image_url.replace('portrait-media:', 'https:') })).status, 403);
  const opened = await f.adapter.imageToOpen({ id: 101, revision: value.revision }); assert.ok(opened.startsWith(path.join(f.root, 'assets/images/'))); assert.deepEqual(await fs.readFile(opened), f.bytes);
  const changedPrompts = { en: 'Updated\n English ', zh: '修改\n 中文 ' };
  const changed = await f.invoke('library-update', { id: 101, label: 'updated', type: 'art', prompts: changedPrompts, expectedVersion: created.data.revision, expectedRevision: value.revision }); assert.equal(changed.ok, true);
  assert.deepEqual((await f.invoke('library-get', 101)).data.item.prompts, changedPrompts);
  const deleted = await f.invoke('library-delete', { id: 101, expectedVersion: changed.data.revision, expectedRevision: changed.data.items[0].revision, confirmed: true }); assert.equal(deleted.ok, true); assert.equal(deleted.data.items.length, 0);
  assert.deepEqual(await fs.readFile(f.sourceImage), f.bytes); assert.deepEqual(await fs.readdir(f.profile), []);
});

test('local remote-connection IPC is unavailable, sanitized and protected by exact frame and argument checks', async t => {
  const f = await localFixture(t);
  for (const [name, args] of [['library-connection-save', [{ endpoint: 'https://unused.invalid/' }]], ['library-connection-login', []], ['library-connection-logout', []]]) {
    const result = await f.invoke(name, ...args); assert.equal(result.error.code, 'BACKEND_UNSUPPORTED'); assert.equal(JSON.stringify(result).includes('/private/'), false);
  }
  assert.equal((await f.invoke('library-list', { root: '/etc' })).error.code, 'INVALID_INPUT');
  for (const name of ['library-connection-settings', 'library-connection-login', 'copy-prompt']) {
    const result = await f.handlers.get(name)({ sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } });
    if (name === 'copy-prompt') assert.equal(result, false); else assert.equal(result.error.code, 'FORBIDDEN');
  }
  await f.adapter.dispose(); assert.equal((await f.invoke('library-list')).error.code, 'ABORTED');
  assert.equal(await f.invoke('copy-prompt', { id: 1, revision: 1, language: 'en' }), false);
});

test('local startup preserves custom saved roots and migrates only the exact legacy default', async t => {
  for (const saved of ['custom', 'legacy']) {
    const f = await localFixture(t, { saved });
    assert.equal((await f.invoke('library-list')).data.root, saved === 'custom' ? f.custom : f.root);
    const configuration = JSON.parse(await fs.readFile(path.join(f.profile, 'library-config.json'), 'utf8'));
    assert.equal(configuration.root, saved === 'custom' ? f.custom : f.root);
  }
});

test('local disposal waits for a started delete transaction before completing', async t => {
  const f = await localFixture(t), initial = (await f.invoke('library-list')).data;
  f.choices.push({ canceled: false, filePaths: [f.sourceImage] }); const selected = (await f.invoke('library-image-choose')).data;
  const created = await f.invoke('library-create', { id: 101, label: 'owned quit fixture', type: 'photo', prompts: { en: 'whole English', zh: '完整中文' }, imageToken: selected.token, expectedVersion: initial.revision }); assert.equal(created.ok, true);
  let signalStarted, finishTrash, disposed = false; const started = new Promise(resolve => { signalStarted = resolve; });
  f.setTrash(filename => { signalStarted(); return new Promise(resolve => { finishTrash = async () => { await fs.unlink(filename); resolve(); }; }); });
  const deleting = f.invoke('library-delete', { id: 101, expectedVersion: created.data.revision, expectedRevision: created.data.items[0].revision, confirmed: true }); await started;
  const closing = f.adapter.dispose().then(() => { disposed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  await finishTrash(); assert.equal((await deleting).ok, true); await closing; assert.equal(disposed, true);
  const persisted = JSON.parse(await fs.readFile(path.join(f.root, '.portrait-studio/library.json'), 'utf8')); assert.equal(persisted.items.length, 0);
  assert.deepEqual(await fs.readFile(f.sourceImage), f.bytes);
});

test('batch delete IPC validates sender and payload, decorates snapshots, and holds the destination until the full batch finishes', async t => {
  const f = await localFixture(t);
  let state = (await f.invoke('library-list')).data;
  for (const id of [101, 102, 103]) {
    f.choices.push({ canceled: false, filePaths: [f.sourceImage] });
    const picked = (await f.invoke('library-image-choose')).data;
    const created = await f.invoke('library-create', { id, label: `batch fixture ${id}`, type: 'photo', prompts: { en: 'complete English', zh: '完整中文' }, expectedVersion: state.revision, imageToken: picked.token });
    assert.equal(created.ok, true); state = created.data;
  }
  const request = { items: state.items.slice(0, 2).map(item => ({ id: item.id, expectedRevision: item.revision })), expectedVersion: state.revision, confirmed: true };
  const handler = f.handlers.get('library-delete-batch');
  const forged = { sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } };
  assert.equal((await handler(forged, request)).error.code, 'FORBIDDEN');
  assert.equal((await f.invoke('library-delete-batch', request, request)).error.code, 'INVALID_INPUT');
  assert.equal((await f.invoke('library-delete-batch', { ...request, path: f.sourceImage })).error.code, 'INVALID_INPUT');
  assert.equal((await f.invoke('library-delete-batch', { ...request, confirmed: false })).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await f.invoke('library-list')).data.items.length, 3);
  let signalStarted, finishTrash, disposed = false, trashes = 0;
  const started = new Promise(resolve => { signalStarted = resolve; });
  f.setTrash(async filename => {
    if (++trashes === 1) { signalStarted(); await new Promise(resolve => { finishTrash = resolve; }); }
    await fs.unlink(filename);
  });
  const deleting = f.invoke('library-delete-batch', request); await started;
  assert.equal((await f.invoke('library-choose')).error.code, 'BUSY');
  const closing = f.adapter.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  finishTrash(); const result = await deleting; await closing;
  assert.equal(result.ok, true); assert.equal(trashes, 2); assert.equal(disposed, true);
  assert.deepEqual(result.data.report, { deletedIds: [101, 102], remainingIds: [], errorCode: null });
  assert.equal(result.data.snapshot.backend, 'local');
  assert.deepEqual(result.data.snapshot.items.map(item => item.id), [103]);
  assert.match(result.data.snapshot.items[0].image_url, /^portrait-media:\/\/asset\/103\?revision=1&library=\d+$/);
  assert.deepEqual(await fs.readFile(f.sourceImage), f.bytes);
});
