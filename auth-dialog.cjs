'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const authPath = path.join(__dirname, 'auth.html'), authURL = pathToFileURL(authPath).href;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const failed = code => ({ ok: false, error: { code } });
const safeError = error => ['AUTH_REQUIRED', 'SESSION_EXPIRED', 'AUTH_NOT_INITIALIZED', 'INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'REMOTE_GATEWAY_AUTH_REQUIRED', 'PLATFORM_AUTH_UNAVAILABLE', 'REMOTE_AUTH_REQUIRED', 'REMOTE_FORBIDDEN', 'REMOTE_ROUTE_MISSING', 'REMOTE_SERVICE_UNAVAILABLE', 'REMOTE_TIMEOUT', 'REMOTE_UNAVAILABLE', 'REMOTE_INVALID_RESPONSE', 'REMOTE_NOT_CONFIGURED', 'INVALID_INPUT'].includes(error?.code) ? error.code : 'REMOTE_UNAVAILABLE';

function createAuthenticationDialog({ BrowserWindow, ipcMain }) {
  let active = null, disposed = false;
  function trusted(event, session) {
    return Boolean(session && event.sender === session.window.webContents && event.senderFrame && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === authURL);
  }
  function finish(session, result) {
    if (active !== session) return;
    active = null; session.resolve(result);
    if (!session.window.isDestroyed()) session.window.close();
  }
  ipcMain.handle('remote-auth-state', (event, ...extra) => {
    if (!trusted(event, active)) return failed('FORBIDDEN');
    if (extra.length) return failed('INVALID_INPUT');
    return { ok: true, data: { locale: active.locale, endpoint: active.endpoint } };
  });
  ipcMain.handle('remote-auth-cancel', (event, ...extra) => {
    if (!trusted(event, active)) return failed('FORBIDDEN');
    if (extra.length) return failed('INVALID_INPUT');
    finish(active, { cancelled: true }); return { ok: true, data: { cancelled: true } };
  });
  ipcMain.handle('remote-auth-submit', async (event, value, ...extra) => {
    const session = active;
    if (!trusted(event, session)) return failed('FORBIDDEN');
    if (extra.length || !plain(value) || Object.keys(value).length !== 2 || Object.keys(value).some(key => !['username', 'password'].includes(key))
      || value.username !== 'admin'
      || typeof value.password !== 'string' || !value.password || Buffer.byteLength(value.password, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(value.password)) {
      if (plain(value)) { value.username = ''; value.password = ''; }
      return failed('INVALID_INPUT');
    }
    if (session.busy) { value.username = ''; value.password = ''; return failed('BUSY'); }
    session.busy = true;
    try {
      const result = await session.authenticate(value);
      if (disposed || active !== session || session.window.isDestroyed()) return failed('CANCELLED');
      finish(session, result); return { ok: true, data: { authenticated: true } };
    } catch (error) { return failed(safeError(error)); }
    finally { value.username = ''; value.password = ''; session.busy = false; }
  });
  function show({ parent, locale = 'zh', endpoint, authenticate, allowLoopback = false }) {
    if (disposed) return Promise.resolve({ cancelled: true });
    if (active) { active.window.focus(); return active.promise; }
    // A public HTTPS endpoint is shown only as a connection label. No credentials
    // are supplied in the URL, HTML, window arguments, or renderer state.
    const url = new URL(endpoint);
    const developmentLoopback = allowLoopback === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && Boolean(url.port);
    if (url.protocol !== 'https:' && !developmentLoopback || url.username || url.password || url.search || url.hash) throw Object.assign(new Error(), { code: 'REMOTE_NOT_CONFIGURED' });
    let resolve; const promise = new Promise(done => { resolve = done; });
    const window = new BrowserWindow({ width: 460, height: 520, resizable: false, minimizable: false, maximizable: false, show: false,
      parent, modal: Boolean(parent), backgroundColor: '#101114', title: locale === 'en' ? 'Platform sign in' : '平台登录',
      webPreferences: { preload: path.join(__dirname, 'auth-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: false, spellcheck: false, partition: `portrait-auth-${randomUUID()}` } });
    const session = { window, locale: locale === 'en' ? 'en' : 'zh', endpoint: url.href, authenticate, promise, resolve, busy: false };
    active = session;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) window.webContents.on(event, value => value.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('render-process-gone', () => finish(session, { cancelled: true }));
    window.on('closed', () => finish(session, { cancelled: true }));
    window.once('ready-to-show', () => { if (active === session && !window.isDestroyed()) window.show(); });
    try { Promise.resolve(window.loadFile(authPath)).catch(() => finish(session, { cancelled: true })); }
    catch { finish(session, { cancelled: true }); }
    return promise;
  }
  function dispose() {
    disposed = true; if (active) finish(active, { cancelled: true });
    for (const channel of ['remote-auth-state', 'remote-auth-submit', 'remote-auth-cancel']) ipcMain.removeHandler?.(channel);
  }
  return { show, dispose };
}

module.exports = { createAuthenticationDialog, authURL };
