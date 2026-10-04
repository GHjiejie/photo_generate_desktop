'use strict';

// This isolated bootstrap loads only the production authentication dialog.
// No app business main, SSH client, server, token or real credential is used.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { PNG } = require('pngjs');
const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const kind = `auth-native-${version}`;
const output = path.join(project, '.verification');
const reportPath = path.join(output, `${kind}-verification.json`);
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-auth-native-')));
const profile = path.join(temporary, 'isolated-profile');
const bootstrap = path.join(temporary, 'bootstrap.cjs');
const authURL = pathToFileURL(path.join(project, 'auth.html')).href;
const endpoint = 'https://auth-native.invalid/';
const fakeUsername = 'native-cancel-fixture-user';
const fakePassword = 'NativeCancelFixtureOnly!';
const channels = ['remote-auth-state', 'remote-auth-submit', 'remote-auth-cancel'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
for (const directory of [output, profile]) fs.mkdirSync(directory, { recursive: true });
const authFiles = ['auth-dialog.cjs', 'auth-preload.js', 'auth.html', 'auth-renderer.js', 'auth.css'];
const sourceHashes = Object.fromEntries(authFiles.map(file => [file, sha(fs.readFileSync(path.join(project, file)))]));
const indexPath = path.join(project, 'photo_repo/.portrait-studio/library.json');
const indexBefore = fs.readFileSync(indexPath);
const index = JSON.parse(indexBefore);
const checks = [], screenshots = [], windows = [], errors = [], clearEvents = [];
let app, ownerPage, stage = 'prepared', mainState, handlersReleased, profileScan;
fs.writeFileSync(bootstrap, [
  "'use strict';",
  "const { app, BrowserWindow, ipcMain } = require('electron');",
  `const { createAuthenticationDialog } = require(${JSON.stringify(path.join(project, 'auth-dialog.cjs'))});`,
  `app.setPath('userData', ${JSON.stringify(profile)});`,
  "globalThis.__authVerification = { authenticateCalls: 0, nodeNetworkCalls: 0, browserNetworkAttempts: 0, results: [], navigation: [], windowOptions: [] };",
  "function ObservedBrowserWindow(options) { const p = options.webPreferences; globalThis.__authVerification.windowOptions.push({ devTools: p.devTools, spellcheck: p.spellcheck, partition: p.partition }); return new BrowserWindow(options); }",
  "globalThis.fetch = async () => { globalThis.__authVerification.nodeNetworkCalls++; throw new Error('Network forbidden in native cancel verification'); };",
  "app.whenReady().then(async () => {",
  "  globalThis.__authOwner = new BrowserWindow({ width: 760, height: 580, title: 'Native auth cancel verification owner', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });",
  "  await globalThis.__authOwner.loadURL('data:text/html;charset=UTF-8,%3Cmeta%20http-equiv%3D%22Content-Security-Policy%22%20content%3D%22default-src%20%27none%27%22%3E%3Cmain%3EAuthentication%20cancel%20verification%3C%2Fmain%3E');",
  "  globalThis.__authDialog = createAuthenticationDialog({ BrowserWindow: ObservedBrowserWindow, ipcMain });",
  "  globalThis.__authBegin = locale => {",
  `    globalThis.__authPending = globalThis.__authDialog.show({ parent: globalThis.__authOwner, locale, endpoint: ${JSON.stringify(endpoint)}, authenticate: async () => { globalThis.__authVerification.authenticateCalls++; throw new Error('Cancel-only native verification must not authenticate'); } });`,
  "    globalThis.__authPending.then(result => globalThis.__authVerification.results.push({ locale, result }));",
  "  };",
  "});",
  "app.on('before-quit', () => globalThis.__authDialog?.dispose());",
  "app.on('window-all-closed', () => app.quit());"
].join('\n'));

function writeReport(status, extra = {}) {
  const value = { status, version, kind, stage, project, temporary, profile, bootstrap, authURL, endpoint,
    scope: 'Isolated native production authentication dialog with canceled fake input; no public authentication, server connection, SSH, token generation or business operation is asserted.',
    substitutions: { authenticate: 'Injected cancel-only callback records invocation count and throws; it must never run.', windowConstructor: 'A test-owned constructor observer records the production options and passes them unchanged to new real Electron BrowserWindow; no security option is overridden.', network: 'Test-owned main fetch throws if called. A safety-only request filter cancels any HTTP/HTTPS/WebSocket attempt; no URL or credential is logged.', input: 'Only fixed synthetic username/password fixtures are filled; profile inspection reports booleans and counts without logging their content.' },
    sourceHashes, windows, checks, screenshots, mainState, handlersReleased, profileScan, clearEvents, errors,
    realLibrary: { count: index.items.length, revision: index.revision, indexSha256Before: sha(indexBefore), indexSha256After: sha(fs.readFileSync(indexPath)), indexUnchanged: indexBefore.equals(fs.readFileSync(indexPath)) }, ...extra };
  fs.writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`); return value;
}
async function closeOwnedApp() { if (app) { await app.close(); app = undefined; } }
async function begin(locale) {
  const pendingWindow = app.waitForEvent('window');
  await app.evaluate((_electron, locale) => { globalThis.__authBegin(locale); }, locale);
  const page = await pendingWindow;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const value = message.text();
    if (value.startsWith('AUTH_CANCEL_FIELD_STATE:')) clearEvents.push(JSON.parse(value.slice('AUTH_CANCEL_FIELD_STATE:'.length)));
    else if (message.type() === 'error') errors.push(value);
  });
  await expect(page.locator('#authForm')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('#authEndpoint')).toHaveText(endpoint);
  const settings = await app.evaluate(({ BrowserWindow }, expectedURL) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === expectedURL);
    if (!window) throw new Error('The expected owned authentication window is missing');
    const prefs = window.webContents.getLastWebPreferences();
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
      globalThis.__authVerification.browserNetworkAttempts++; callback({ cancel: true });
    });
    window.webContents.on('will-navigate', event => globalThis.__authVerification.navigation.push({ prevented: event.defaultPrevented === true }));
    return { pid: process.pid, id: window.id, parentId: window.getParentWindow()?.id, ownerId: globalThis.__authOwner.id,
      modal: window.isModal(), sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration,
      webSecurity: prefs.webSecurity, devTools: globalThis.__authVerification.windowOptions.at(-1).devTools,
      spellcheck: globalThis.__authVerification.windowOptions.at(-1).spellcheck,
      partition: globalThis.__authVerification.windowOptions.at(-1).partition,
      persistentSession: window.webContents.session.isPersistent(), url: window.webContents.getURL() };
  }, authURL);
  expect(settings.parentId).toBe(settings.ownerId); expect(settings.modal).toBe(true);
  expect(settings.sandbox).toBe(true); expect(settings.contextIsolation).toBe(true);
  expect(settings.nodeIntegration).toBe(false); expect(settings.webSecurity).toBe(true);
  expect(settings.devTools).toBe(false); expect(settings.spellcheck).toBe(false);
  expect(settings.partition).toMatch(/^portrait-auth-/); expect(settings.partition).not.toMatch(/^persist:/); expect(settings.persistentSession).toBe(false);
  expect(settings.url).toBe(authURL);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await page.evaluate(() => Object.keys(window.portraitAuthentication).sort())).toEqual(['cancel', 'state', 'submit']);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  for (const rule of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "object-src 'none'"]) expect(csp).toContain(rule);
  expect(csp).not.toContain('unsafe-inline'); expect(csp).not.toContain('unsafe-eval');
  expect(await page.evaluate(() => window.open('about:blank', '_blank') === null)).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: 'geolocation' })).state)).toBe('denied');
  windows.push({ ...settings, locale, csp, popupDenied: true, permissionQuery: 'denied', navigationPrevented: null });
  return page;
}
async function shot(page, name) {
  const filename = `${kind}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
  const pixels = PNG.sync.read(fs.readFileSync(path.join(output, filename)));
  screenshots.push({ filename, pixels: { width: pixels.width, height: pixels.height } });
}
function scanProfile() {
  let files = 0, bytes = 0, fixtureMatches = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // Chromium's transient singleton links carry no credential bytes.
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const value = fs.readFileSync(file); files++; bytes += value.length;
        if (value.includes(Buffer.from(fakePassword)) || value.includes(Buffer.from(fakeUsername))) fixtureMatches++;
      }
    }
  }
  visit(profile); return { files, bytes, fixtureMatches, credentialContentFound: fixtureMatches !== 0 };
}
async function main() {
  try {
    stage = 'isolated-native-launch';
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PORTRAIT_STUDIO_')) delete env[key];
    app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], env });
    ownerPage = await app.firstWindow();
    await expect.poll(() => app.evaluate(() => typeof globalThis.__authBegin)).toBe('function');
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
    stage = 'native-password-and-cancel';
    const zh = await begin('zh');
    await expect(zh.locator('#authUsername')).toHaveAttribute('autocomplete', 'off');
    await expect(zh.locator('#authPassword')).toHaveAttribute('type', 'password');
    await expect(zh.locator('#authPassword')).toHaveAttribute('autocomplete', 'off');
    await zh.locator('#authUsername').fill(fakeUsername); await zh.locator('#authPassword').fill(fakePassword);
    await expect(zh.locator('#authPassword')).toHaveValue(fakePassword);
    await shot(zh, 'zh-fake-input-masked');
    await zh.evaluate(() => document.getElementById('authCancel').addEventListener('click', () => {
      console.info('AUTH_CANCEL_FIELD_STATE:' + JSON.stringify({ usernameEmpty: document.getElementById('authUsername').value === '', passwordEmpty: document.getElementById('authPassword').value === '' }));
    }));
    const closed = zh.waitForEvent('close'); await zh.locator('#authCancel').click(); await closed;
    await expect.poll(() => app.evaluate(() => globalThis.__authVerification.results.length)).toBe(1);
    expect(clearEvents).toEqual([{ usernameEmpty: true, passwordEmpty: true }]);
    expect(await app.evaluate(() => globalThis.__authVerification.results[0])).toEqual({ locale: 'zh', result: { cancelled: true } });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    checks.push('Native Chinese modal masks fake password, uses only the fixed preload bridge, clears both fields before cancel IPC and closes without invoking authentication.');
    stage = 'native-window-close';
    const en = await begin('en'); await expect(en.locator('#authTitle')).toHaveText('Server sign in');
    await en.locator('#authUsername').fill(fakeUsername); await en.locator('#authPassword').fill(fakePassword);
    await shot(en, 'en-fake-input-masked');
    // Electron prevents this navigation before a new document loads. Playwright
    // may retain a pending navigation, so no later DOM action is required.
    await en.evaluate(() => { location.href = 'https://auth-native.invalid/blocked-navigation'; });
    await expect.poll(() => app.evaluate(() => globalThis.__authVerification.navigation.length)).toBe(1);
    expect(await app.evaluate(() => globalThis.__authVerification.navigation[0].prevented)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }, expectedURL) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === expectedURL)?.webContents.getURL(), authURL)).toBe(authURL);
    windows.at(-1).navigationPrevented = true;
    const closeEvent = en.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }, expectedURL) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === expectedURL).close(), authURL);
    await closeEvent;
    await expect.poll(() => app.evaluate(() => globalThis.__authVerification.results.length)).toBe(2);
    expect(await app.evaluate(() => globalThis.__authVerification.results[1])).toEqual({ locale: 'en', result: { cancelled: true } });
    checks.push('Native English modal close resolves cancellation; owner survives and no server authentication or token is created.');
    stage = 'dispose-and-profile-preservation';
    handlersReleased = await app.evaluate(({ ipcMain }, channels) => {
      globalThis.__authDialog.dispose();
      const available = {};
      for (const channel of channels) {
        try { ipcMain.handle(channel, () => ({ testOnly: true })); available[channel] = true; }
        catch { available[channel] = false; }
        finally { if (available[channel]) ipcMain.removeHandler(channel); }
      }
      return available;
    }, channels);
    expect(handlersReleased).toEqual(Object.fromEntries(channels.map(channel => [channel, true])));
    mainState = await app.evaluate(() => globalThis.__authVerification);
    expect(mainState.authenticateCalls).toBe(0); expect(mainState.nodeNetworkCalls).toBe(0); expect(mainState.browserNetworkAttempts).toBe(0);
    expect(mainState.navigation).toHaveLength(1); expect(mainState.navigation.every(event => event.prevented)).toBe(true);
    expect(indexBefore.equals(fs.readFileSync(indexPath))).toBe(true);
    expect(errors).toEqual([]);
    await closeOwnedApp();
    profileScan = scanProfile(); expect(profileScan.fixtureMatches).toBe(0);
    checks.push('Both native dialogs enforce sandbox, isolation, no Node, ephemeral session, strict CSP, blocked navigation/popup and denied permission query. Dispose removes all three auth handlers; profile contains no fake credential content and real library index is unchanged.');
    stage = 'complete'; writeReport('passed');
    console.log(JSON.stringify({ status: 'passed', report: reportPath, checks: checks.length, authenticateCalls: mainState.authenticateCalls, networkAttempts: mainState.nodeNetworkCalls + mainState.browserNetworkAttempts, handlerCleanup: true, credentialContentFound: profileScan.credentialContentFound }));
  } catch (error) {
    if (app) { try { mainState = await app.evaluate(() => globalThis.__authVerification); } catch {} }
    writeReport('failed', { error: error.stack }); console.error(error); process.exitCode = 1;
  } finally { await closeOwnedApp(); }
}
main();
