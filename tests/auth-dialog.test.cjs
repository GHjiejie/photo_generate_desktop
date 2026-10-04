'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createAuthenticationDialog, authURL } = require('../auth-dialog.cjs');

function fixture(t, authenticate = async () => ({ client: { mainMemoryOnly: true }, snapshot: { items: [] } })) {
  const windows = [], handlers = new Map(), removed = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: { url: authURL }, setWindowOpenHandler: handler => { this.popup = handler; }, session: { setPermissionRequestHandler: handler => { this.permission = handler; }, setPermissionCheckHandler: handler => { this.permissionCheck = handler; } } });
      windows.push(this);
    }
    loadFile(filename) { this.loaded = filename; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('closed'); }
    show() { this.visible = true; }
    focus() { this.focused = true; }
  }
  const controller = createAuthenticationDialog({ BrowserWindow: FakeWindow, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => { handlers.delete(channel); removed.push(channel); } } });
  const show = () => controller.show({ parent: {}, locale: 'en', endpoint: 'https://server.invalid/portrait-studio/', authenticate });
  const event = () => ({ sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame });
  const invoke = (channel, ...args) => handlers.get(channel)(event(), ...args);
  t.after(() => controller.dispose()); return { windows, handlers, removed, controller, show, event, invoke };
}

test('authentication has a dedicated sandboxed memory session, fixed file URL and no navigation or permissions', async t => {
  const f = fixture(t), pending = f.show(), window = f.windows[0], prefs = window.options.webPreferences;
  assert.equal(window.options.modal, true); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true); assert.equal(prefs.devTools, false); assert.equal(prefs.spellcheck, false); assert.equal(prefs.partition.startsWith('persist:'), false);
  assert.equal(window.loaded, path.join(__dirname, '../auth.html')); assert.deepEqual(window.popup(), { action: 'deny' });
  for (const name of ['will-navigate', 'will-redirect', 'will-attach-webview']) { let prevented = false; window.webContents.emit(name, { preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); }
  let permission; window.permission(null, 'clipboard-read', value => { permission = value; }); assert.equal(permission, false); assert.equal(window.permissionCheck(), false);
  const state = f.invoke('remote-auth-state'); assert.deepEqual(state, { ok: true, data: { locale: 'en', endpoint: 'https://server.invalid/portrait-studio/' } });
  f.invoke('remote-auth-cancel'); assert.deepEqual(await pending, { cancelled: true });
});

test('only the active authentication window main frame can use its three fixed IPC methods', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; }), pending = f.show(), genuine = f.event();
  for (const [channel, handler] of f.handlers) for (const event of [{ sender: { mainFrame: genuine.senderFrame }, senderFrame: genuine.senderFrame }, { sender: genuine.sender, senderFrame: { url: authURL } }, { sender: genuine.sender, senderFrame: { url: 'file:///gallery/index.html' } }]) {
    const result = await handler(event, { username: 'fake', password: 'fake-only-test' }); assert.equal(result.error.code, 'FORBIDDEN');
  }
  assert.equal(calls, 0); assert.equal(f.invoke('remote-auth-state', 'extra').error.code, 'INVALID_INPUT'); assert.equal(f.invoke('remote-auth-cancel', 'extra').error.code, 'INVALID_INPUT');
  f.invoke('remote-auth-cancel'); await pending;
});

test('successful authentication returns its verified client only to main and no credentials to renderer', async t => {
  const privateResult = { client: { mainMemoryOnly: true }, snapshot: { items: [] } }; const f = fixture(t, async value => { assert.equal(value.username, 'admin'); assert.equal(value.password, ' fake-only-test '); return privateResult; });
  const pending = f.show(), credentials = { username: 'admin', password: ' fake-only-test ' }, result = await f.invoke('remote-auth-submit', credentials);
  assert.deepEqual(result, { ok: true, data: { authenticated: true } }); assert.equal(await pending, privateResult); assert.deepEqual(credentials, { username: '', password: '' }); assert.equal(f.windows[0].destroyed, true);
});

test('wrong credentials and invalid inputs keep the window recoverable and return only sanitized codes', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('secret must never escape'), { code: 'REMOTE_AUTH_REQUIRED' }); }), pending = f.show();
  const credentials = { username: 'admin', password: 'fake-only-test' }; assert.deepEqual(await f.invoke('remote-auth-submit', credentials), { ok: false, error: { code: 'REMOTE_AUTH_REQUIRED' } }); assert.deepEqual(credentials, { username: '', password: '' }); assert.equal(f.windows[0].destroyed, false);
  const invalid = { username: 'colon:user', password: 'fake-only-test' }; assert.equal((await f.invoke('remote-auth-submit', invalid)).error.code, 'INVALID_INPUT'); assert.deepEqual(invalid, { username: '', password: '' });
  f.invoke('remote-auth-cancel'); assert.deepEqual(await pending, { cancelled: true });
});

test('authentication preserves platform and server status codes without exposing error details', async t => {
  for (const code of ['AUTH_NOT_INITIALIZED', 'INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'SESSION_EXPIRED', 'REMOTE_GATEWAY_AUTH_REQUIRED', 'PLATFORM_AUTH_UNAVAILABLE', 'REMOTE_FORBIDDEN', 'REMOTE_ROUTE_MISSING', 'REMOTE_SERVICE_UNAVAILABLE', 'REMOTE_TIMEOUT']) {
    const f = fixture(t, async () => { throw Object.assign(new Error('private upstream details'), { code }); });
    const pending = f.show(), credentials = { username: 'admin', password: 'fake-only-test' };
    assert.deepEqual(await f.invoke('remote-auth-submit', credentials), { ok: false, error: { code } });
    assert.deepEqual(credentials, { username: '', password: '' });
    f.invoke('remote-auth-cancel'); assert.deepEqual(await pending, { cancelled: true });
  }
});

test('only fixed admin credentials and bounded UTF-8 passwords reach authentication', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; }), pending = f.show();
  for (const credentials of [{ username: 'other-user', password: 'fake-only-test' }, { username: 'Admin', password: 'fake-only-test' }, { username: 'admin', password: '界'.repeat(342) }]) {
    assert.equal((await f.invoke('remote-auth-submit', credentials)).error.code, 'INVALID_INPUT');
    assert.deepEqual(credentials, { username: '', password: '' });
  }
  assert.equal(calls, 0); f.invoke('remote-auth-cancel'); await pending;
});

test('HTTP sign-in is allowed only for an explicitly selected development loopback', async t => {
  const f = fixture(t);
  for (const [endpoint, allowLoopback] of [['http://127.0.0.1:4137/', false], ['http://server.invalid:4137/', true], ['http://127.0.0.1/', true]]) {
    assert.throws(() => f.controller.show({ endpoint, allowLoopback, authenticate: async () => ({}) }), error => error.code === 'REMOTE_NOT_CONFIGURED');
  }
  const pending = f.controller.show({ endpoint: 'http://127.0.0.1:4137/', allowLoopback: true, authenticate: async () => ({}) });
  f.invoke('remote-auth-cancel'); assert.deepEqual(await pending, { cancelled: true });
});

test('cancel, renderer crash and dispose invalidate a pending verification and never publish its late client', async t => {
  for (const action of ['cancel', 'crash', 'dispose']) {
    let resolveVerification; const f = fixture(t, async () => new Promise(resolve => { resolveVerification = resolve; })), pending = f.show();
    const submitting = f.invoke('remote-auth-submit', { username: 'admin', password: 'fake-only-test' });
    if (action === 'cancel') f.invoke('remote-auth-cancel'); else if (action === 'crash') f.windows[0].webContents.emit('render-process-gone'); else f.controller.dispose();
    assert.deepEqual(await pending, { cancelled: true }); resolveVerification({ client: { mustNotPublish: true }, snapshot: {} }); assert.equal((await submitting).error.code, 'CANCELLED');
    if (action === 'dispose') assert.equal(f.handlers.size, 0);
  }
});

test('authentication coalesces concurrent windows and rejects repeated submissions while one verification is pending', async t => {
  let resolveVerification; const f = fixture(t, async () => new Promise(resolve => { resolveVerification = resolve; })), pending = f.show(); assert.equal(f.show(), pending); assert.equal(f.windows.length, 1);
  const first = f.invoke('remote-auth-submit', { username: 'admin', password: 'fake-only-test' }); const second = { username: 'admin', password: 'other-fake' };
  assert.equal((await f.invoke('remote-auth-submit', second)).error.code, 'BUSY'); assert.deepEqual(second, { username: '', password: '' });
  f.invoke('remote-auth-cancel'); await pending; resolveVerification({}); await first;
});

test('authentication preload exposes only state, submit and cancel, and HTML forbids network and form navigation', async () => {
  const preload = await fs.readFile(path.join(__dirname, '../auth-preload.js'), 'utf8'); let bridge; const calls = [];
  vm.runInNewContext(preload, { require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'portraitAuthentication'); bridge = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } }; } });
  assert.deepEqual(Object.keys(bridge).sort(), ['cancel', 'state', 'submit']); await bridge.state(); await bridge.cancel(); assert.deepEqual(calls, [['remote-auth-state'], ['remote-auth-cancel']]);
  const html = await fs.readFile(path.join(__dirname, '../auth.html'), 'utf8'); assert.match(html, /type="password"/); for (const policy of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "script-src 'self'"]) assert.ok(html.includes(policy));
  assert.match(html, /id="authUsername"[^>]*value="admin"[^>]*readonly/);
  const renderer = await fs.readFile(path.join(__dirname, '../auth-renderer.js'), 'utf8'); assert.doesNotMatch(renderer, /localStorage|sessionStorage|console\.|fetch\(/);
});
