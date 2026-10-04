'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PNG } = require('pngjs');
const { createRemoteAdapter, readSelected } = require('../remote-electron.cjs');
const { trustedSender } = require('../electron-security.cjs');
const { authURL } = require('../auth-dialog.cjs');
const { writeRemoteConfiguration, RECOMMENDED_ENDPOINT, FILE_NAME } = require('../remote-config.cjs');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const image = color => { const png = new PNG({ width: 2, height: 3 }); for (let i = 0; i < png.data.length; i += 4) png.data.set([color, 45, 98, 255], i); return PNG.sync.write(png); };
const row = (id = 1) => ({ id, image: `${String(id).padStart(3, '0')}-fixture.png`, label: '原始完整标签', prompt_en: ' English prompt\n  preserve trailing spaces. ', prompt_cn: ' 中文完整提示词\n  保留空格。 ', original: { value: ['original', id] } });
async function tree(root) {
  const files = {};
  async function scan(directory) { for (const name of (await fs.readdir(directory)).sort()) { const filename = path.join(directory, name), stat = await fs.lstat(filename); if (stat.isDirectory()) await scan(filename); else files[path.relative(root, filename)] = stat.isSymbolicLink() ? `symlink:${await fs.readlink(filename)}` : sha(await fs.readFile(filename)); } }
  await scan(root); return files;
}
async function fixture(t, { realClient = false, baseURL = '', savedEndpoint, authorization } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-remote-ipc-'))), source = path.join(base, 'source'), protectedRoot = path.join(base, 'photo_repo');
  await fs.mkdir(path.join(source, 'images'), { recursive: true }); await fs.mkdir(protectedRoot);
  await fs.writeFile(path.join(protectedRoot, 'existing-original.json'), '{"unchanged":true}\n');
  const sourceRow = row(), bytes = image(71), sourceImage = path.join(source, 'images', sourceRow.image), manifest = Buffer.from(JSON.stringify({ exporter: 'kept exactly', images: [sourceRow] }, null, 2) + '\n');
  await fs.writeFile(sourceImage, bytes); await fs.writeFile(path.join(source, 'manifest.json'), manifest);
  const item = { id: 1, label: sourceRow.label, type: 'photo', prompts: { en: sourceRow.prompt_en, zh: sourceRow.prompt_cn }, image: '001-remote.png', revision: 1, sha256: sha(bytes), size: bytes.length, mime: 'image/png', sourceMetadata: sourceRow };
  const snapshot = () => ({ configured: true, root: 'Remote portrait library', writable: true, revision: 1, items: [structuredClone(item)] });
  const calls = [], choices = [], handlers = new Map(), clipboard = [], dialogs = [];
  let media;
  const client = {
    connection: { transport: 'loopback-development', endpoint: 'http://127.0.0.1:44337/' },
    sessionMetadata: null,
    authStatus: async () => { calls.push(['auth-status']); return { initialized: true, authenticated: false }; },
    clearSession() { this.sessionMetadata = null; this.connection = { ...this.connection, authorizationProvided: false }; },
    withoutSession() { const next = { ...this }; next.clearSession(); return next; },
    logout: async function () { calls.push(['logout']); this.clearSession(); return { loggedOut: true }; },
    list: async () => { calls.push(['list']); return snapshot(); },
    get: async id => { calls.push(['get', id]); if (id !== 1) throw Object.assign(new Error(), { code: 'NOT_FOUND' }); return { revision: 1, item: structuredClone(item) }; },
    image: async value => { calls.push(['image', value.id]); return bytes; },
    mutate: async (method, metadata, selected) => { calls.push(['mutate', method, metadata, selected]); return { snapshot: snapshot(), item }; },
    preview: async value => { calls.push(['preview', value]); return { previewId: randomUUID(), root: 'Remote portrait library', revision: 1, total: 1, matched: 1, importable: 1, skipped: 0, conflicts: 0, items: [{ id: 1, status: 'importable' }], issues: [], unpaired: [], canImport: true }; },
    commit: async (token, value) => { calls.push(['commit', token, value]); return { snapshot: snapshot(), report: { imported: 1, skipped: 0, conflicts: 0, mapping: [] } }; },
    cancel: async token => { calls.push(['cancel', token]); return { cancelled: true }; }
  };
  const rendererURL = 'file:///remote-adapter-test/index.html', frame = { url: rendererURL }, sender = { mainFrame: frame }, event = { sender, senderFrame: frame };
  const authWindows = [];
  class TestWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: { url: authURL }, setWindowOpenHandler: () => {}, session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } }); authWindows.push(this); }
    static fromWebContents() { return null; }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    show() {}
    focus() {}
    loadFile() { return Promise.resolve(); }
  }
  const profile = path.join(base, 'profile');
  if (savedEndpoint) await writeRemoteConfiguration(profile, savedEndpoint);
  const adapter = createRemoteAdapter({ app: { isPackaged: false, getPath: name => { if (name === 'userData') return profile; assert.equal(name, 'temp'); return base; } }, ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }, dialog: { showOpenDialog: async (_window, options) => { dialogs.push(options); return choices.shift() || { canceled: true, filePaths: [] }; } }, protocol: { handle: (name, handler) => { assert.equal(name, 'portrait-media'); media = handler; } }, nativeImage: { createFromBuffer: value => ({ isEmpty: () => value.length === 0, getSize: () => ({ width: 2, height: 3 }) }) }, BrowserWindow: TestWindow, clipboard: { writeText: value => clipboard.push(value) }, rendererURL, trustedSender, remoteClient: realClient ? undefined : client, baseURL, authorization });
  await adapter.initialise();
  t.after(async () => { await adapter.dispose(); await fs.rm(base, { recursive: true, force: true }); });
  const invoke = (name, ...args) => { assert.ok(handlers.has(name), name); return handlers.get(name)(event, ...args); };
  const chooseDirectory = async () => { choices.push({ canceled: false, filePaths: [source] }); const result = await invoke('library-batch-directory-choose'); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  const chooseImage = async () => { choices.push({ canceled: false, filePaths: [sourceImage] }); const result = await invoke('library-image-choose'); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  const preview = selection => invoke('library-batch-preview', { directorySelectionId: selection.selectionId, manifestCandidateId: selection.manifests[0].candidateId, type: 'photo' });
  return { base, profile, source, protectedRoot, sourceImage, sourceRow, bytes, manifest, item, client, calls, choices, handlers, event, dialogs, clipboard, adapter, invoke, chooseDirectory, chooseImage, preview, authWindows, media: request => media(request) };
}
function failed(value, code) { assert.equal(value.ok, false, JSON.stringify(value)); assert.equal(value.error.code, code, JSON.stringify(value)); }
function platformCandidate(f, overrides = {}) {
  return { ...f.client, connection: { ...f.client.connection, authorizationProvided: true },
    sessionMetadata: { kind: 'platform', username: 'admin', expiresAt: new Date(Date.now() + 60000).toISOString() }, ...overrides };
}
async function beginSignIn(f, candidate) {
  f.client.login = async value => { assert.deepEqual(value, { username: 'admin', password: 'fake-only-test' }); return { client: candidate, session: candidate.sessionMetadata }; };
  const pending = f.invoke('library-connection-login'); await new Promise(resolve => setImmediate(resolve));
  const window = f.authWindows.at(-1); assert.ok(window, 'native platform sign-in window');
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { pending, window, event, submit: value => f.handlers.get('remote-auth-submit')(event, value || { username: 'admin', password: 'fake-only-test' }), cancel: () => f.handlers.get('remote-auth-cancel')(event) };
}
async function signIn(f, candidate = platformCandidate(f)) {
  const flow = await beginSignIn(f, candidate); assert.deepEqual(await flow.submit(), { ok: true, data: { authenticated: true } });
  const response = await flow.pending; assert.equal(response.ok, true, JSON.stringify(response)); return { candidate, response };
}

test('remote CRUD forwards only fixed metadata and selected bytes, and never writes a local business library', async t => {
  const f = await fixture(t), before = await tree(f.base), selected = await f.chooseImage();
  const list = await f.invoke('library-list'); assert.equal(list.data.remote, true); assert.match(list.data.items[0].image_url, /^portrait-media:\/\/asset\/1\?/);
  const metadata = { id: 2, label: '新素材', type: 'photo', prompts: { en: ' Whole\nEnglish ', zh: ' 完整\n中文 ' }, expectedVersion: 1, imageToken: selected.token };
  const result = await f.invoke('library-create', metadata); assert.equal(result.ok, true);
  const mutation = f.calls.find(value => value[0] === 'mutate'); assert.equal(mutation[1], 'create'); assert.deepEqual(mutation[2], Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'imageToken')));
  assert.deepEqual(mutation[3].bytes, f.bytes); assert.equal(Object.hasOwn(mutation[2], 'path'), false);
  assert.deepEqual(await tree(f.base), before);
  failed(await f.invoke('library-create', { ...metadata, path: '/etc/passwd' }), 'INVALID_INPUT');
  failed(await f.invoke('library-delete', { id: 1, expectedVersion: 1, expectedRevision: 1, confirmed: false }), 'CONFIRMATION_REQUIRED');
  assert.equal((await f.invoke('library-delete', { id: 1, expectedVersion: 1, expectedRevision: 1, confirmed: true })).ok, true);
  assert.deepEqual(await tree(f.protectedRoot), { 'existing-original.json': sha(Buffer.from('{"unchanged":true}\n')) });
});

test('all remote IPC rejects unauthorized frames and extra arguments before reading or uploading', async t => {
  const f = await fixture(t); f.calls.length = 0;
  for (const [name, handler] of f.handlers) {
    const result = await handler({ sender: f.event.sender, senderFrame: { url: f.event.senderFrame.url } }, {});
    if (name === 'copy-prompt') assert.equal(result, false); else failed(result, 'FORBIDDEN');
  }
  assert.equal(f.calls.length, 0);
  failed(await f.invoke('library-list', { endpoint: 'https://attacker.invalid/' }), 'INVALID_INPUT');
  failed(await f.invoke('library-get', 1, '/etc/passwd'), 'INVALID_INPUT');
  failed(await f.invoke('library-choose', '/Users/jie/photo_repo'), 'INVALID_INPUT');
});

test('native image token pins inode, bytes and ancestor paths, and release/refresh removes authority', async t => {
  const f = await fixture(t), first = await f.chooseImage();
  await fs.writeFile(f.sourceImage, image(73));
  failed(await f.invoke('library-create', { id: 2, label: 'a', type: 'photo', prompts: { en: 'e', zh: '中' }, expectedVersion: 1, imageToken: first.token }), 'SOURCE_CHANGED');
  assert.equal(f.calls.some(value => value[0] === 'mutate'), false);
  const second = await f.chooseImage(); await f.invoke('library-image-release', second.token);
  failed(await f.invoke('library-create', { id: 2, imageToken: second.token }), 'INVALID_IMAGE_SELECTION');
  const third = await f.chooseImage(); await f.invoke('library-choose');
  failed(await f.invoke('library-create', { id: 2, imageToken: third.token }), 'INVALID_IMAGE_SELECTION');
  const link = path.join(f.base, 'image-link.png'); await fs.symlink(f.sourceImage, link);
  await assert.rejects(readSelected(link), error => error.code === 'UNSAFE_PATH');
});

test('single-directory preview uploads original manifest and nested relative image paths, then commits only pinned private lease', async t => {
  const f = await fixture(t), before = await tree(f.base), directory = await f.chooseDirectory();
  assert.equal(f.dialogs.length, 1); assert.deepEqual(f.dialogs[0].properties, ['openDirectory']);
  const result = await f.preview(directory); assert.equal(result.ok, true, JSON.stringify(result));
  const preview = result.data, upload = f.calls.find(value => value[0] === 'preview')[1];
  assert.deepEqual(upload.manifestBytes, f.manifest); assert.equal(upload.manifestRelativePath, 'manifest.json');
  assert.equal(upload.images[0].relativePath, `images/${f.sourceRow.image}`); assert.deepEqual(upload.images[0].bytes, f.bytes);
  const localId = preview.previewId;
  const commit = await f.invoke('library-batch-commit', { previewId: localId, expectedVersion: 1, confirmed: true }); assert.equal(commit.ok, true);
  const remoteId = f.calls.find(value => value[0] === 'commit')[1]; assert.notEqual(remoteId, localId);
  failed(await f.invoke('library-batch-commit', { previewId: localId, expectedVersion: 1, confirmed: true }), 'INVALID_BATCH_SELECTION');
  assert.deepEqual(await tree(f.base), before);
});

test('source replacement and forbidden batch fields block remote commit without touching old local data', async t => {
  const f = await fixture(t), before = await tree(f.protectedRoot), directory = await f.chooseDirectory();
  for (const key of ['path', 'manifestPath', 'collisionPolicy', 'derivedChinesePrompts', 'endpoint', 'authorization']) failed(await f.invoke('library-batch-preview', { directorySelectionId: directory.selectionId, manifestCandidateId: directory.manifests[0].candidateId, type: 'photo', [key]: '/bad' }), 'INVALID_INPUT');
  const result = await f.preview(directory); assert.equal(result.ok, true);
  await fs.writeFile(f.sourceImage, image(114));
  failed(await f.invoke('library-batch-commit', { previewId: result.data.previewId, expectedVersion: 1, confirmed: true }), 'SOURCE_CHANGED');
  assert.equal(f.calls.some(value => value[0] === 'commit'), false); assert.deepEqual(await tree(f.protectedRoot), before);
});

test('closing or disposing during an in-flight upload cancels the late remote lease', async t => {
  for (const action of ['cancel', 'dispose']) {
    const f = await fixture(t), directory = await f.chooseDirectory();
    let resolveUpload, markStarted; const started = new Promise(resolve => { markStarted = resolve; });
    const remoteId = randomUUID();
    f.client.preview = async () => { markStarted(); return new Promise(resolve => { resolveUpload = () => resolve({ previewId: remoteId, root: 'Remote portrait library', revision: 1, total: 1, matched: 1, importable: 1, skipped: 0, conflicts: 0, items: [], issues: [], unpaired: [], canImport: true }); }); };
    const pending = f.preview(directory); await started;
    if (action === 'cancel') assert.equal((await f.invoke('library-batch-cancel', { directorySelectionId: directory.selectionId })).ok, true);
    else await f.adapter.dispose();
    resolveUpload(); failed(await pending, 'INVALID_BATCH_SELECTION');
    assert.ok(f.calls.some(value => value[0] === 'cancel' && value[1] === remoteId));
    assert.equal(f.calls.some(value => value[0] === 'commit'), false);
  }
});

test('media bridge rejects arbitrary URLs and stale authority, and copy fetches full current selected language', async t => {
  const f = await fixture(t), snapshot = (await f.invoke('library-list')).data;
  const response = await f.media({ method: 'GET', url: snapshot.items[0].image_url }); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  for (const url of ['https://attacker.invalid/v1/images/1', 'portrait-media://asset/1?revision=1&library=1&path=/etc/passwd', 'portrait-media://asset/1?revision=1&revision=1&library=1', 'portrait-media://import/../../etc/passwd', 'portrait-media://user:password@asset/1?revision=1&library=1']) assert.equal((await f.media({ method: 'GET', url })).status, 403, url);
  assert.equal((await f.media({ method: 'POST', url: snapshot.items[0].image_url })).status, 405);
  assert.equal(await f.invoke('copy-prompt', { id: 1, revision: 1, language: 'zh' }), true); assert.deepEqual(f.clipboard, [f.sourceRow.prompt_cn]);
  assert.equal(await f.invoke('copy-prompt', { id: 1, revision: 2, language: 'en' }), false); assert.equal(f.clipboard.length, 1);
  await f.invoke('library-choose'); assert.equal((await f.media({ method: 'GET', url: snapshot.items[0].image_url })).status, 403);
});

test('a pending prompt read cannot write the clipboard after disconnecting selections or disposing', async t => {
  for (const action of ['refresh', 'dispose']) {
    const f = await fixture(t); let resolveGet, markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    f.client.get = async () => { markStarted(); return new Promise(resolve => { resolveGet = resolve; }); };
    const copying = f.invoke('copy-prompt', { id: 1, revision: 1, language: 'zh' }); await started;
    if (action === 'refresh') await f.invoke('library-choose'); else await f.adapter.dispose();
    resolveGet({ revision: 1, item: f.item }); assert.equal(await copying, false); assert.deepEqual(f.clipboard, []);
  }
});

test('opening the original writes only a verified temporary file and removes it on disposal', async t => {
  const f = await fixture(t), old = await tree(f.protectedRoot), opened = await f.adapter.imageToOpen({ id: 1, revision: 1 });
  assert.ok(opened.startsWith(path.join(f.base, 'portrait-studio-image-'))); assert.deepEqual(await fs.readFile(opened), f.bytes); assert.equal((await fs.stat(opened)).mode & 0o777, 0o600);
  await f.adapter.dispose(); assert.equal(await fs.lstat(opened).catch(() => null), null); assert.deepEqual(await tree(f.protectedRoot), old);
});

test('disposing during a pending original-image download creates no late temporary copy', async t => {
  const f = await fixture(t), before = await tree(f.base);
  let resolveImage, startedImage; const started = new Promise(resolve => { startedImage = resolve; });
  f.client.image = async () => { startedImage(); return new Promise(resolve => { resolveImage = resolve; }); };
  const opening = f.adapter.imageToOpen({ id: 1, revision: 1 }); await started;
  await f.adapter.dispose(); resolveImage(f.bytes);
  await assert.rejects(opening, error => error.code === 'REMOTE_UNAVAILABLE'); assert.deepEqual(await tree(f.base), before);
});

test('remote outage returns an explicit error and does not configure or mutate local storage', async t => {
  const f = await fixture(t), before = await tree(f.base);
  f.client.list = async () => { throw Object.assign(new Error('unavailable'), { code: 'REMOTE_UNAVAILABLE' }); };
  const result = await f.invoke('library-list'); assert.equal(result.ok, false);
  assert.equal((await f.invoke('library-choose')).ok, false); assert.deepEqual(await tree(f.base), before);
  const main = await fs.readFile(path.join(__dirname, '../main.js'), 'utf8'); assert.match(main, /process\.env\.PORTRAIT_STUDIO_BACKEND === 'remote' \? 'remote' : 'local'/); assert.match(main, /if \(backend === 'remote'\)/);
});

test('HTTPS challenges stay explicit and sign-in serializes verification without publishing late old responses', async t => {
  const f = await fixture(t), before = await tree(f.base); let candidates = 0, verified = 0, requests = 0, rejectLate;
  f.client.connection = { transport: 'https', endpoint: 'https://server.invalid/portrait-studio/' };
  const originalList = f.client.list;
  const candidate = { ...f.client, connection: { ...f.client.connection, authorizationProvided: true }, list: async () => { verified++; return originalList(); } };
  f.client.list = async () => {
    if (++requests === 3) return new Promise((_resolve, reject) => { rejectLate = reject; });
    throw Object.assign(new Error(), { code: 'REMOTE_AUTH_REQUIRED' });
  };
  candidate.sessionMetadata = { kind: 'platform', username: 'admin', expiresAt: new Date(Date.now() + 60000).toISOString() };
  f.client.withBasicCredentials = () => { throw new Error('legacy gateway credentials must not be used'); };
  f.client.login = async credentials => { candidates++; assert.deepEqual(credentials, { username: 'admin', password: 'fake-only-test' }); return { client: candidate, session: candidate.sessionMetadata }; };
  const first = f.invoke('library-list'), second = f.invoke('library-list'), late = f.invoke('library-list'); await new Promise(resolve => setImmediate(resolve));
  const initial = await Promise.all([first, second]); for (const response of initial) failed(response, 'REMOTE_AUTH_REQUIRED'); assert.equal(f.authWindows.length, 0);
  const signingIn = f.invoke('library-connection-login'); await new Promise(resolve => setImmediate(resolve));
  failed(await f.invoke('library-connection-login'), 'BUSY');
  assert.equal(f.authWindows.length, 1); const authWindow = f.authWindows[0], authEvent = { sender: authWindow.webContents, senderFrame: authWindow.webContents.mainFrame };
  const submitted = await f.handlers.get('remote-auth-submit')(authEvent, { username: 'admin', password: 'fake-only-test' });
  assert.deepEqual(submitted, { ok: true, data: { authenticated: true } });
  const signedIn = await signingIn; assert.equal(signedIn.ok, true, JSON.stringify(signedIn));
  assert.equal(candidates, 1); assert.equal(verified, 1);
  assert.deepEqual(signedIn.data.authentication, candidate.sessionMetadata);
  assert.equal(JSON.stringify(signedIn).includes('fake-only-test'), false); assert.equal(JSON.stringify(signedIn).includes('test-user'), false);
  await new Promise(resolve => setImmediate(resolve));
  rejectLate(Object.assign(new Error(), { code: 'REMOTE_AUTH_REQUIRED' }));
  failed(await late, 'CONFLICT'); assert.equal(f.authWindows.length, 1); assert.equal(verified, 1);
  await f.invoke('library-list'); assert.equal(verified, 2); assert.deepEqual(await tree(f.base), before);
});

test('canceling an HTTPS sign-in preserves the existing main client and creates no local credential files', async t => {
  const f = await fixture(t), before = await tree(f.base); let candidates = 0;
  f.client.connection = { transport: 'https', endpoint: 'https://server.invalid/portrait-studio/' };
  f.client.list = async () => { throw Object.assign(new Error(), { code: 'REMOTE_AUTH_REQUIRED' }); };
  f.client.login = () => { candidates++; throw new Error('must not run'); };
  const pending = f.invoke('library-connection-login'); await new Promise(resolve => setImmediate(resolve)); const authWindow = f.authWindows[0];
  await f.handlers.get('remote-auth-cancel')({ sender: authWindow.webContents, senderFrame: authWindow.webContents.mainFrame });
  assert.deepEqual(await pending, { ok: true, data: { cancelled: true } }); assert.equal(candidates, 0);
  assert.equal((await f.invoke('library-get', 1)).ok, true); assert.deepEqual(await tree(f.base), before);
});

test('an unconfigured desktop reads recommended settings without network, and saves only the HTTPS address', async t => {
  const f = await fixture(t, { realClient: true }), before = await tree(f.base);
  const initial = (await f.invoke('library-connection-settings')).data;
  assert.equal(initial.configured, false); assert.equal(initial.status, 'unconfigured'); assert.equal(initial.endpoint, ''); assert.equal(initial.recommendedEndpoint, RECOMMENDED_ENDPOINT);
  failed(await f.invoke('library-list'), 'REMOTE_NOT_CONFIGURED'); assert.deepEqual(await tree(f.base), before);
  const saved = await f.invoke('library-connection-save', { endpoint: RECOMMENDED_ENDPOINT }); assert.equal(saved.ok, true); assert.equal(saved.data.status, 'configured'); assert.equal(saved.data.source, 'saved'); assert.equal(saved.data.authorizationProvided, false); assert.equal(Object.hasOwn(saved.data, 'items'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.profile, FILE_NAME), 'utf8')), { version: 1, endpoint: RECOMMENDED_ENDPOINT }); assert.equal((await fs.stat(path.join(f.profile, FILE_NAME))).mode & 0o777, 0o600);
  failed(await f.invoke('library-connection-save', { endpoint: 'https://server.invalid/', password: 'fake-only-test' }), 'INVALID_INPUT');
});

test('restart loads a saved HTTPS address without copying environment credentials to it, while explicit environment overrides remain fixed', async t => {
  const saved = await fixture(t, { realClient: true, savedEndpoint: RECOMMENDED_ENDPOINT, authorization: 'Bearer fake-only-test' });
  const settings = (await saved.invoke('library-connection-settings')).data; assert.equal(settings.source, 'saved'); assert.equal(settings.endpoint, RECOMMENDED_ENDPOINT); assert.equal(settings.status, 'configured'); assert.equal(settings.authorizationProvided, false);
  const environment = await fixture(t, { realClient: true, savedEndpoint: RECOMMENDED_ENDPOINT, baseURL: 'https://env.invalid/api/', authorization: 'Bearer fake-only-test' });
  const before = await tree(environment.base), fromEnv = (await environment.invoke('library-connection-settings')).data;
  assert.equal(fromEnv.source, 'environment'); assert.equal(fromEnv.environmentOverride, true); assert.equal(fromEnv.endpoint, 'https://env.invalid/api/'); assert.equal(fromEnv.authorizationProvided, true);
  failed(await environment.invoke('library-connection-save', { endpoint: 'https://replacement.invalid/' }), 'REMOTE_ENVIRONMENT_OVERRIDE'); assert.deepEqual(await tree(environment.base), before);
});

test('failed persistence preserves the old main client, image authority and unknown existing file', async t => {
  const f = await fixture(t), imageSelection = await f.chooseImage(), oldEndpoint = f.client.connection.endpoint;
  await fs.mkdir(f.profile); const raw = '{"unrelated":"preserve exactly"}\n'; await fs.writeFile(path.join(f.profile, FILE_NAME), raw, { mode: 0o600 });
  failed(await f.invoke('library-connection-save', { endpoint: RECOMMENDED_ENDPOINT }), 'INVALID_REMOTE_CONFIG');
  assert.equal((await f.invoke('library-connection-settings')).data.endpoint, oldEndpoint); assert.equal(await fs.readFile(path.join(f.profile, FILE_NAME), 'utf8'), raw);
  assert.equal((await f.invoke('library-create', { id: 2, label: 'new', type: 'photo', prompts: { en: 'English', zh: '中文' }, expectedVersion: 1, imageToken: imageSelection.token })).ok, true);
});

test('switching endpoints clears old credentials, selection tokens and remote leases without claiming a connection', async t => {
  const f = await fixture(t), selected = await f.chooseImage(), directory = await f.chooseDirectory(), preview = await f.preview(directory); assert.equal(preview.ok, true);
  f.client.connection.authorizationProvided = true;
  const result = await f.invoke('library-connection-save', { endpoint: RECOMMENDED_ENDPOINT }); assert.equal(result.ok, true); assert.equal(result.data.status, 'configured'); assert.equal(result.data.authorizationProvided, false); assert.equal(result.data.lastErrorCode, null);
  assert.ok(f.calls.some(value => value[0] === 'cancel'));
  failed(await f.invoke('library-create', { id: 2, imageToken: selected.token }), 'INVALID_IMAGE_SELECTION'); failed(await f.invoke('library-batch-commit', { previewId: preview.data.previewId, expectedVersion: 1, confirmed: true }), 'INVALID_BATCH_SELECTION');
});

test('late responses from an old endpoint cannot become a new snapshot, portrait, authentication status or opened image', async t => {
  for (const operation of ['list', 'get', '401', 'open']) {
    const f = await fixture(t); let resolveRequest, rejectRequest, markStarted; const started = new Promise(resolve => { markStarted = resolve; });
    const pendingResult = () => { markStarted(); return new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }); };
    let pending;
    if (operation === 'list' || operation === '401') { f.client.list = pendingResult; pending = f.invoke('library-list'); }
    else if (operation === 'get') { f.client.get = pendingResult; pending = f.invoke('library-get', 1); }
    else { f.client.image = pendingResult; pending = f.adapter.imageToOpen({ id: 1, revision: 1 }); }
    await started; assert.equal((await f.invoke('library-connection-save', { endpoint: RECOMMENDED_ENDPOINT })).ok, true);
    if (operation === '401') rejectRequest(Object.assign(new Error(), { code: 'REMOTE_AUTH_REQUIRED' }));
    else resolveRequest(operation === 'list' ? { configured: true, root: 'Old library', writable: true, revision: 1, items: [f.item] } : operation === 'get' ? { revision: 1, item: f.item } : f.bytes);
    if (operation === 'open') await assert.rejects(pending, error => error.code === 'CONFLICT'); else failed(await pending, 'CONFLICT');
    const status = (await f.invoke('library-connection-settings')).data; assert.equal(status.endpoint, RECOMMENDED_ENDPOINT); assert.equal(status.status, 'configured'); assert.equal(status.lastErrorCode, null); assert.equal(f.authWindows.length, 0);
    assert.equal((await fs.readdir(f.base)).some(name => name.startsWith('portrait-studio-image-')), false);
  }
});

test('platform sign-in publishes only fixed admin metadata after verifying the library and never exposes credentials', async t => {
  const f = await fixture(t), before = await tree(f.base), candidate = platformCandidate(f);
  candidate.sessionMetadata.sessionToken = 'fake-only-private-client-value';
  f.client.withBasicCredentials = () => { throw new Error('platform passwords cannot configure Basic authentication'); };
  const { response } = await signIn(f, candidate), settings = (await f.invoke('library-connection-settings')).data;
  const expected = { kind: 'platform', username: 'admin', expiresAt: candidate.sessionMetadata.expiresAt };
  assert.deepEqual(response.data.authentication, expected); assert.deepEqual(settings.authentication, expected);
  assert.equal(settings.initialized, true); assert.equal(settings.developmentLoginAllowed, true);
  const serialized = JSON.stringify([response, settings, await f.invoke('library-list')]);
  for (const secret of ['sessionToken', 'fake-only-private-client-value', 'fake-only-test', 'Bearer ']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(await tree(f.base), before);
  const preload = await fs.readFile(path.join(__dirname, '../preload.js'), 'utf8');
  assert.match(preload, /logout: \(\) => ipcRenderer\.invoke\('library-connection-logout'\)/);
  assert.doesNotMatch(preload, /sessionToken|authStatus|withBasicCredentials|remote-auth-submit/);
});

test('public auth status distinguishes uninitialized, gateway-only and missing platform API without opening a password dialog', async t => {
  for (const code of ['AUTH_NOT_INITIALIZED', 'REMOTE_GATEWAY_AUTH_REQUIRED', 'PLATFORM_AUTH_UNAVAILABLE']) {
    const f = await fixture(t); let attempts = 0, probes = 0;
    f.client.list = async () => { throw Object.assign(new Error(), { code: 'AUTH_REQUIRED' }); };
    f.client.login = async () => { attempts++; throw new Error('must not request a password'); };
    f.client.authStatus = async () => { probes++; if (code !== 'AUTH_NOT_INITIALIZED') throw Object.assign(new Error(), { code }); return { initialized: false, authenticated: false }; };
    failed(await f.invoke('library-list'), code); assert.equal(probes, 1); assert.equal(f.authWindows.length, 0); assert.equal(attempts, 0);
    failed(await f.invoke('library-connection-login'), code); assert.equal(f.authWindows.length, 0); assert.equal(attempts, 0);
    const settings = (await f.invoke('library-connection-settings')).data; assert.equal(settings.status, 'error'); assert.equal(settings.authentication, null);
    assert.equal(settings.initialized, code === 'AUTH_NOT_INITIALIZED' ? false : null);
    f.client.authStatus = async () => ({ initialized: true, authenticated: false });
    failed(await f.invoke('library-choose'), 'AUTH_REQUIRED'); assert.equal((await f.invoke('library-connection-settings')).data.initialized, true);
  }
});

test('invalid admin passwords remain in the isolated dialog and do not change the active main client', async t => {
  const f = await fixture(t), before = await tree(f.base), candidate = platformCandidate(f), flow = await beginSignIn(f, candidate);
  f.client.login = async () => { throw Object.assign(new Error('private diagnostic must not be returned'), { code: 'INVALID_CREDENTIALS' }); };
  const credentials = { username: 'admin', password: 'fake-only-test' }, response = await flow.submit(credentials);
  assert.deepEqual(response, { ok: false, error: { code: 'INVALID_CREDENTIALS' } }); assert.deepEqual(credentials, { username: '', password: '' });
  assert.equal(flow.window.isDestroyed(), false); assert.equal((await f.invoke('library-connection-settings')).data.authentication, null);
  await flow.cancel(); assert.deepEqual(await flow.pending, { ok: true, data: { cancelled: true } });
  assert.equal((await f.invoke('library-get', 1)).ok, true); assert.deepEqual(await tree(f.base), before);
});

test('a candidate session whose library verification fails is revoked without publishing authentication', async t => {
  const f = await fixture(t); let revoked = 0;
  const candidate = platformCandidate(f, { list: async () => { throw Object.assign(new Error(), { code: 'REMOTE_ROUTE_MISSING' }); }, logout: async function () { revoked++; this.clearSession(); return { loggedOut: true }; } });
  const flow = await beginSignIn(f, candidate), credentials = { username: 'admin', password: 'fake-only-test' };
  assert.deepEqual(await flow.submit(credentials), { ok: false, error: { code: 'REMOTE_ROUTE_MISSING' } });
  assert.equal(revoked, 1); assert.equal(candidate.sessionMetadata, null); assert.deepEqual(credentials, { username: '', password: '' });
  assert.equal((await f.invoke('library-connection-settings')).data.authentication, null);
  await flow.cancel(); assert.deepEqual(await flow.pending, { ok: true, data: { cancelled: true } });
});

test('cancel or disposal during candidate verification revokes the private session and ignores late status changes', async t => {
  for (const action of ['cancel-success', 'cancel-error', 'dispose']) {
    const f = await fixture(t); let finish, reject, startedVerification, revoked = 0;
    const started = new Promise(resolve => { startedVerification = resolve; });
    const candidate = platformCandidate(f, { list: async () => { startedVerification(); return new Promise((resolve, failure) => { finish = resolve; reject = failure; }); }, logout: async function () { revoked++; this.clearSession(); return { loggedOut: true }; } });
    const flow = await beginSignIn(f, candidate), credentials = { username: 'admin', password: 'fake-only-test' }, submitting = flow.submit(credentials); await started;
    assert.deepEqual(credentials, { username: '', password: '' }, 'password is cleared before the library read');
    if (action === 'dispose') await f.adapter.dispose(); else await flow.cancel();
    assert.deepEqual(await flow.pending, { ok: true, data: { cancelled: true } });
    const before = (await f.invoke('library-connection-settings')).data;
    if (action === 'cancel-error') reject(Object.assign(new Error(), { code: 'REMOTE_SERVICE_UNAVAILABLE' }));
    else finish({ configured: true, root: 'Cancelled library', writable: true, revision: 1, items: [f.item] });
    assert.equal((await submitting).ok, false); assert.equal(revoked, 1); assert.equal(candidate.sessionMetadata, null);
    assert.deepEqual((await f.invoke('library-connection-settings')).data, before);
  }
});

test('ordinary session rejection clears credentials and source authority without opening another dialog', async t => {
  for (const channel of ['library-list', 'library-get', 'copy-prompt', 'media', 'open']) {
    const f = await fixture(t), { candidate, response } = await signIn(f), selection = await f.chooseImage(), directory = await f.chooseDirectory(), preview = await f.preview(directory);
    const rejectSession = async () => { candidate.clearSession(); throw Object.assign(new Error(), { code: 'SESSION_EXPIRED' }); };
    candidate.list = rejectSession; candidate.get = rejectSession;
    if (channel === 'copy-prompt') assert.equal(await f.invoke(channel, { id: 1, revision: 1, language: 'en' }), false);
    else if (channel === 'media') assert.equal((await f.media({ method: 'GET', url: response.data.items[0].image_url })).status, 404);
    else if (channel === 'open') await assert.rejects(f.adapter.imageToOpen({ id: 1, revision: 1 }), error => error.code === 'SESSION_EXPIRED');
    else failed(await f.invoke(channel, ...(channel === 'library-get' ? [1] : [])), 'SESSION_EXPIRED');
    const state = (await f.invoke('library-connection-settings')).data; assert.equal(state.authentication, null); assert.equal(state.lastErrorCode, 'SESSION_EXPIRED');
    assert.equal(f.authWindows.length, 1); assert.ok(f.calls.some(call => call[0] === 'cancel'));
    failed(await f.invoke('library-create', { id: 2, imageToken: selection.token }), 'INVALID_IMAGE_SELECTION');
    failed(await f.invoke('library-batch-commit', { previewId: preview.data.previewId, confirmed: true, expectedVersion: 1 }), 'INVALID_BATCH_SELECTION');
    assert.deepEqual(f.clipboard, []);
  }
});

test('logout clears local authentication even offline and reports remote revocation only when confirmed', async t => {
  for (const offline of [false, true]) {
    const f = await fixture(t), { candidate } = await signIn(f), selection = await f.chooseImage(), directory = await f.chooseDirectory(), preview = await f.preview(directory), order = [];
    candidate.cancel = async () => { order.push('cancel'); assert.ok(candidate.sessionMetadata); return { cancelled: true }; };
    candidate.logout = async function () { order.push('logout'); assert.ok(this.sessionMetadata); if (offline) throw Object.assign(new Error('secret remote body'), { code: 'REMOTE_UNAVAILABLE' }); this.clearSession(); return { loggedOut: true }; };
    failed(await f.invoke('library-connection-logout', { token: 'never-accepted' }), 'INVALID_INPUT');
    const result = await f.invoke('library-connection-logout'); assert.equal(result.ok, true); assert.equal(result.data.authentication, null); assert.equal(result.data.lastErrorCode, 'AUTH_REQUIRED');
    assert.equal(result.data.serverLoggedOut, !offline); assert.equal(result.data.logoutErrorCode, offline ? 'REMOTE_UNAVAILABLE' : null); assert.equal(Object.hasOwn(result.data, 'items'), false);
    assert.deepEqual(order, ['cancel', 'logout']); assert.equal(candidate.sessionMetadata, null); assert.equal(JSON.stringify(result).includes('secret'), false);
    failed(await f.invoke('library-create', { id: 2, imageToken: selection.token }), 'INVALID_IMAGE_SELECTION');
    failed(await f.invoke('library-batch-commit', { previewId: preview.data.previewId, confirmed: true, expectedVersion: 1 }), 'INVALID_BATCH_SELECTION');
  }
});

test('the main expiry timer removes session and selection authority without any renderer request', async t => {
  const f = await fixture(t), candidate = platformCandidate(f, { sessionMetadata: { kind: 'platform', username: 'admin', expiresAt: new Date(Date.now() + 200).toISOString() } });
  await signIn(f, candidate); const selection = await f.chooseImage();
  await new Promise(resolve => setTimeout(resolve, 230));
  const state = (await f.invoke('library-connection-settings')).data; assert.equal(state.authentication, null); assert.equal(state.lastErrorCode, 'SESSION_EXPIRED'); assert.equal(candidate.sessionMetadata, null);
  failed(await f.invoke('library-create', { id: 2, imageToken: selection.token }), 'INVALID_IMAGE_SELECTION'); assert.equal(f.authWindows.length, 1);
});

test('clearing an authenticated client after an unknown 401 cannot leave stale authentication metadata', async t => {
  const f = await fixture(t), { candidate } = await signIn(f);
  candidate.get = async () => { candidate.clearSession(); throw Object.assign(new Error(), { code: 'REMOTE_INVALID_RESPONSE' }); };
  failed(await f.invoke('library-get', 1), 'AUTH_REQUIRED'); const state = (await f.invoke('library-connection-settings')).data;
  assert.equal(state.authentication, null); assert.equal(state.lastErrorCode, 'AUTH_REQUIRED'); assert.equal(f.authWindows.length, 1);
});

test('a late rejected request from the previous session cannot invalidate a newly verified admin session', async t => {
  const f = await fixture(t), { candidate: previous } = await signIn(f); let rejectPrevious, signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  previous.get = async () => { signalStarted(); return new Promise((_resolve, reject) => { rejectPrevious = reject; }); };
  const oldRequest = f.invoke('library-get', 1); await started;
  const next = platformCandidate(f), expiresAt = next.sessionMetadata.expiresAt;
  previous.login = async () => ({ client: next, session: next.sessionMetadata });
  const signingIn = f.invoke('library-connection-login'); await new Promise(resolve => setImmediate(resolve));
  const window = f.authWindows.at(-1), event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.deepEqual(await f.handlers.get('remote-auth-submit')(event, { username: 'admin', password: 'fake-only-test' }), { ok: true, data: { authenticated: true } });
  assert.equal((await signingIn).ok, true);
  rejectPrevious(Object.assign(new Error(), { code: 'SESSION_EXPIRED' })); failed(await oldRequest, 'CONFLICT');
  const settings = (await f.invoke('library-connection-settings')).data;
  assert.deepEqual(settings.authentication, { kind: 'platform', username: 'admin', expiresAt }); assert.equal(settings.status, 'connected'); assert.equal(settings.lastErrorCode, null);
  assert.equal((await f.invoke('library-get', 1)).ok, true);
});

test('session expiry during refresh lease cancellation prevents publishing the previously read snapshot', async t => {
  const f = await fixture(t), candidate = platformCandidate(f, { sessionMetadata: { kind: 'platform', username: 'admin', expiresAt: new Date(Date.now() + 200).toISOString() } });
  await signIn(f, candidate); const directory = await f.chooseDirectory(); assert.equal((await f.preview(directory)).ok, true);
  let releaseCancel, signalCancel; const cancelling = new Promise(resolve => { signalCancel = resolve; });
  candidate.cancel = async () => { signalCancel(); return new Promise(resolve => { releaseCancel = resolve; }); };
  const refreshing = f.invoke('library-choose'); await cancelling; await new Promise(resolve => setTimeout(resolve, 230));
  releaseCancel({ cancelled: true }); failed(await refreshing, 'CONFLICT');
  const state = (await f.invoke('library-connection-settings')).data; assert.equal(state.authentication, null); assert.equal(state.status, 'error'); assert.equal(state.lastErrorCode, 'SESSION_EXPIRED');
});
