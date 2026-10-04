'use strict';

// The HTTP status matrix is test-owned. Production main/preload/React run intact;
// the only real network operation is one unauthenticated GET to the fixed public
// recommended endpoint. No business mutation, credential, SSH or clipboard use.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const kind = `connection-native-${version}`;
const output = path.join(project, '.verification');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-connection-native-')));
const profile = path.join(temporary, 'isolated-profile');
const bootstrap = path.join(temporary, 'bootstrap.cjs');
const configurationPath = path.join(profile, 'remote-connection.json');
const reportPath = path.join(output, `${kind}-verification.json`);
const attempt = new Date().toISOString().replace(/[^0-9TZ]/g, '');
const attemptReportPath = path.join(output, `${kind}-${attempt}-verification.json`);
const recommendedEndpoint = 'https://dashboard-18-180-65-241.sslip.io/portrait-studio/';
const sourceFiles = ['main.js', 'preload.js', 'remote-config.cjs', 'remote-client.cjs', 'remote-electron.cjs', 'src/App.jsx', 'src/components/RemoteConnectionDialog.jsx', 'src/components/Settings.jsx', 'src/ui-messages.json', 'renderer-dist/index.html'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
for (const directory of [output, profile]) fs.mkdirSync(directory, { recursive: true });
let app, page, stage = 'prepared', sourceHashes, realLibraryBefore, realLibraryAfter, configSaved, startup, restart, publicProbe, lastMainState;
const checks = [], screenshots = [], security = [], matrix = [], launches = [], errors = [], diagnostics = [];

function libraryTree() {
  const root = path.join(project, 'photo_repo'), files = [];
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name), key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in real library preservation read');
      if (entry.isDirectory()) visit(child, key);
      else if (entry.isFile()) { const bytes = fs.readFileSync(child); files.push({ path: key, size: bytes.length, sha256: sha(bytes) }); }
    }
  }
  visit(root);
  const index = JSON.parse(fs.readFileSync(path.join(root, '.portrait-studio/library.json'), 'utf8'));
  return { count: index.items.length, revision: index.revision, files, treeSha256: sha(JSON.stringify(files)) };
}
function fileConfiguration() {
  const stat = fs.lstatSync(configurationPath);
  return { path: configurationPath, mode: (stat.mode & 0o777).toString(8), symlink: stat.isSymbolicLink(), value: JSON.parse(fs.readFileSync(configurationPath, 'utf8')), sha256: sha(fs.readFileSync(configurationPath)) };
}
function writeReport(status, extra = {}) {
  let configuration = null;
  try { if (fs.existsSync(configurationPath)) configuration = fileConfiguration(); }
  catch (error) { configuration = { readError: error.code || error.name }; }
  const report = { status, stage, version, attempt, attemptReportPath, project, temporary, profile, bootstrap, recommendedEndpoint,
    scope: 'Real isolated Electron source app and address-only main-process persistence. HTTP status matrix uses explicitly synthetic transport responses; the one public probe is read-only and unauthenticated. No public login, remote business data or write, SSH, local fallback, generated image, OS clipboard or original user application is exercised.',
    substitutions: { fetch: 'A test-owned bootstrap installs an HTTP transport observer before production main constructs RemoteClient. It accepts only unauthenticated GET /portrait-studio/v1/library to the fixed recommended endpoint. Matrix modes supply 401/403/404/503, invalid JSON, a transport error or a valid empty snapshot. Public mode transparently invokes the captured original fetch once. No headers, request bodies or credentials are logged.', viewport: 'Playwright sets the renderer viewport to 1440x920; actual PNG dimensions and native content size are recorded separately.' },
    sourceHashes, checks, screenshots, security, matrix, launches, errors, diagnostics, startup, restart, publicProbe, configuration, lastMainState,
    realLibrary: { before: realLibraryBefore, after: realLibraryAfter, unchanged: Boolean(realLibraryBefore && realLibraryAfter && realLibraryBefore.treeSha256 === realLibraryAfter.treeSha256) }, ...extra };
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(attemptReportPath, bytes); fs.writeFileSync(reportPath, bytes); return report;
}
function prepareBootstrap() {
  fs.writeFileSync(bootstrap, [
    "'use strict';",
    "const { app, ipcMain } = require('electron');",
    `app.setPath('userData', ${JSON.stringify(profile)});`,
    "globalThis.__connectionNative = { mode: 'network', calls: [], ipc: [], rejectedRequests: 0 };",
    "const originalFetch = globalThis.fetch;",
    "globalThis.fetch = async (url, options = {}) => {",
    "  const state = globalThis.__connectionNative;",
    `  if (String(url) !== ${JSON.stringify(recommendedEndpoint + 'v1/library')} || options.method !== 'GET' || new Headers(options.headers).has('authorization') || options.body !== undefined) { state.rejectedRequests++; throw new Error('Native connection verification rejects non-library, authenticated or mutating network requests'); }`,
    "  const request = new URL(String(url));",
    "  const call = { mode: state.mode, method: options.method, route: request.pathname, authenticated: false, bodyPresent: false }; state.calls.push(call);",
    "  if (state.mode === 'public') { try { const result = await originalFetch(url, options); call.status = result.status; return result; } catch (error) { call.transportFailed = true; const code = error?.cause?.code; if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) call.networkCode = code; throw new TypeError('Public connection unavailable'); } }",
    "  if (state.mode === 'network') { call.transportFailed = true; throw new TypeError('Synthetic test transport unavailable'); }",
    "  const status = Number(state.mode);",
    "  if ([401, 403, 404, 503].includes(status)) { call.status = status; return new Response('Synthetic status fixture', { status, headers: { 'Content-Type': 'text/plain' } }); }",
    "  if (state.mode === 'invalid-response') { call.status = 200; return new Response('{invalid synthetic JSON', { status: 200, headers: { 'Content-Type': 'application/json' } }); }",
    "  if (state.mode === 'empty') { call.status = 200; return new Response(JSON.stringify({ ok: true, data: { configured: true, writable: false, root: 'Synthetic empty transport fixture', revision: 0, items: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }",
    "  throw new Error('Unsupported test transport mode');",
    "};",
    "const originalHandle = ipcMain.handle.bind(ipcMain);",
    "ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {",
    "  const result = await handler(...args);",
    "  if (['library-connection-settings', 'library-connection-save', 'library-connection-login', 'library-list', 'library-choose'].includes(channel)) globalThis.__connectionNative.ipc.push({ channel, ok: result?.ok, errorCode: result?.error?.code || null, cancelled: result?.data?.cancelled === true, configured: result?.data?.configured, itemCount: Array.isArray(result?.data?.items) ? result.data.items.length : undefined });",
    "  return result;",
    "});",
    `require(${JSON.stringify(path.join(project, 'main.js'))});`
  ].join('\n'));
}
async function state() { return app.evaluate(() => globalThis.__connectionNative); }
async function mode(value) { await app.evaluate((_electron, value) => { globalThis.__connectionNative.mode = value; }, value); }
async function closeOwned() {
  if (!app) return;
  const pid = app.process().pid;
  await app.close(); app = undefined; page = undefined;
  const launch = launches.findLast(value => value.pid === pid);
  if (launch) { launch.closed = true; try { process.kill(pid, 0); launch.processGone = false; } catch (error) { launch.processGone = error.code === 'ESRCH'; } }
}
async function launch() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PORTRAIT_STUDIO_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  app = await electron.launch({ executablePath: require('electron'), args: [bootstrap], env });
  launches.push({ pid: app.process().pid, profile, closed: false });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#settingsToggle')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 920 });
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile);
  expect(await page.evaluate(() => window.portraitStudio.backend)).toBe('remote');
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  const settings = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity, url: window.webContents.getURL(), contentSize: window.getContentSize() };
  });
  expect(settings.sandbox).toBe(true); expect(settings.contextIsolation).toBe(true); expect(settings.nodeIntegration).toBe(false); expect(settings.webSecurity).toBe(true);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).not.toContain('unsafe-eval'); expect(csp).toContain("connect-src 'none'");
  const localModules = await app.evaluate((_electron, root) => {
    const require = process.getBuiltinModule('module').createRequire(root + '/main.js');
    return Object.keys(require.cache).filter(file => /\/(?:local-electron|local-library|library-batch-transaction|preview-library)\.cjs$/.test(file));
  }, project);
  expect(localModules).toEqual([]);
  security.push({ ...settings, csp, rendererRequire: 'undefined', backend: 'remote', localFallbackModulesLoaded: localModules, passwordInputsInReact: await page.locator('input[type="password"]').count(), rendererViewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
  expect(security.at(-1).passwordInputsInReact).toBe(0);
}
async function openSettings() {
  await page.locator('#settingsToggle').click();
  await page.locator('#settingsConnection').click();
  await expect(page.locator('#remoteConnectionDialog')).toBeVisible();
  await expect(page.locator('#remoteSaveConnect')).toBeEnabled();
}
async function setLanguage(language) {
  if (await page.locator('#remoteConnectionDialog').isVisible()) await page.locator('#remoteConnectionClose').click();
  await page.locator('#settingsToggle').click();
  await page.locator(`#uiLanguage [data-language="${language}"]`).click();
  await page.locator('#settingsConnection').click();
  await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
}
async function shot(name, synthetic) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const filename = `${kind}-${attempt}-${name}-1440x920.png`, filepath = path.join(output, filename);
  await page.screenshot({ path: filepath, scale: 'css', animations: 'disabled' });
  const png = PNG.sync.read(fs.readFileSync(filepath));
  expect({ width: png.width, height: png.height }).toEqual({ width: 1440, height: 920 });
  screenshots.push({ filename, path: filepath, syntheticHTTPResponse: synthetic, pixels: { width: png.width, height: png.height }, rendererViewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
}
async function connectAndAssert(transport, status, expectedCode, name) {
  await mode(transport);
  const before = (await state()).calls.length;
  await page.locator('#remoteSaveConnect').click();
  await expect(page.locator('#remoteConnectionStatus')).toHaveClass(new RegExp(`status-${status}$`));
  await expect(page.locator('#remoteSaveConnect')).toBeEnabled();
  const observed = await state();
  expect(observed.calls.length).toBe(before + 1);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await page.locator('.portrait-card').count()).toBe(0);
  const ipc = observed.ipc.findLast(value => value.channel === 'library-choose');
  if (expectedCode) expect(ipc.errorCode).toBe(expectedCode);
  else { expect(ipc.ok).toBe(true); expect(ipc.itemCount).toBe(0); }
  const result = { name, synthetic: true, transport, uiStatus: status, text: await page.locator('#remoteConnectionStatus').innerText(), ipc, call: observed.calls.at(-1), cardCount: 0 };
  matrix.push(result); return result;
}
async function main() {
  try {
    const rendererHTML = fs.readFileSync(path.join(project, 'renderer-dist/index.html'), 'utf8');
    const rendererAssets = [...rendererHTML.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)].map(match => `renderer-dist/${match[1]}`);
    sourceHashes = Object.fromEntries([...sourceFiles, ...rendererAssets].map(file => [file, sha(fs.readFileSync(path.join(project, file)))]));
    realLibraryBefore = libraryTree(); prepareBootstrap();
    stage = 'isolated-unconfigured-launch'; await launch(); await openSettings();
    await expect(page.locator('#remoteEndpoint')).toHaveValue(recommendedEndpoint);
    await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-unconfigured$/);
    await expect(page.locator('#remoteSignIn')).toBeDisabled();
    startup = { settings: await page.evaluate(() => window.portraitStudio.connectionSettings()), state: await state() };
    expect(startup.settings.ok).toBe(true); expect(startup.settings.data.endpoint).toBe(''); expect(startup.settings.data.recommendedEndpoint).toBe(recommendedEndpoint);
    expect(startup.state.calls).toHaveLength(0); expect(startup.state.rejectedRequests).toBe(0); expect(fs.existsSync(configurationPath)).toBe(false);
    await shot('unconfigured-zh', false);
    checks.push('Actual source app starts unconfigured, displays the recommended HTTPS address, performs zero network requests and loads no local business fallback.');

    stage = 'invalid-endpoint-ui-and-main';
    for (const [name, endpoint] of [['http', 'http://127.0.0.1:44138/'], ['credential-uri', 'https://fixture-user:fixture-password@example.invalid/'], ['malformed', 'https://']]) {
      const before = await state();
      await page.locator('#remoteEndpoint').fill(endpoint); await page.locator('#remoteSaveConnect').click();
      // Native URL validation may stop malformed inputs before React submits.
      const validity = await page.locator('#remoteEndpoint').evaluate(input => input.validity.valid);
      if (validity) await expect(page.locator('#remoteConnectionValidation')).toBeVisible();
      const direct = await page.evaluate(endpoint => window.portraitStudio.saveConnection({ endpoint }), endpoint);
      expect(direct.ok).toBe(false); expect(direct.error.code).toBe('INVALID_REMOTE_ENDPOINT');
      const after = await state(); expect(after.calls).toHaveLength(before.calls.length); expect(fs.existsSync(configurationPath)).toBe(false);
      matrix.push({ name: `invalid-${name}`, synthetic: false, nativeURLValid: validity, mainError: direct.error.code, networkRequests: 0, configurationWritten: false });
    }
    await page.locator('#remoteEndpoint').fill(recommendedEndpoint);
    checks.push('HTTP, credential-bearing URI and malformed address are rejected before network or configuration writes by the real UI and main IPC.');

    stage = 'address-save-and-http-status-matrix';
    await connectAndAssert('401', 'auth-required', 'REMOTE_AUTH_REQUIRED', 'http-401');
    configSaved = fileConfiguration();
    expect(configSaved.mode).toBe('600'); expect(configSaved.symlink).toBe(false);
    expect(configSaved.value).toEqual({ version: 1, endpoint: recommendedEndpoint });
    expect(Object.keys(configSaved.value).sort()).toEqual(['endpoint', 'version']);
    await expect(page.locator('#remoteSignIn')).toBeEnabled();
    await shot('auth-required-zh-mocked', true);
    // Entry verification uses no input or credentials; native cancellation is
    // required to leave both the saved endpoint and HTTP request count unchanged.
    const beforeLoginState = await state(), beforeLogin = beforeLoginState.calls.length, beforeLoginIPC = beforeLoginState.ipc.length, opening = app.waitForEvent('window');
    await page.locator('#remoteSignIn').click(); const authPage = await opening;
    await expect(authPage.locator('#authForm')).toBeVisible(); await expect(authPage.locator('#authPassword')).toHaveAttribute('type', 'password');
    await expect(authPage.locator('#authUsername')).toHaveValue(''); await expect(authPage.locator('#authPassword')).toHaveValue('');
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    const closed = authPage.waitForEvent('close'); await authPage.locator('#authCancel').click(); await closed;
    await expect.poll(async () => (await state()).ipc.slice(beforeLoginIPC).find(value => value.channel === 'library-connection-login')).toMatchObject({ ok: true, cancelled: true });
    await expect(page.locator('#remoteSaveConnect')).toBeEnabled();
    expect((await state()).calls).toHaveLength(beforeLogin); expect(fileConfiguration()).toEqual(configSaved);
    checks.push('The real save IPC atomically writes only version and endpoint with mode 0600. Sign-in opens the separate native password modal; credential-free cancellation leaves address and request count unchanged.');
    await connectAndAssert('404', 'route-missing', 'REMOTE_ROUTE_MISSING', 'http-404'); await shot('route-missing-zh-mocked', true);
    await connectAndAssert('403', 'forbidden', 'REMOTE_FORBIDDEN', 'http-403');
    await connectAndAssert('503', 'service-unavailable', 'REMOTE_SERVICE_UNAVAILABLE', 'http-503');
    await connectAndAssert('invalid-response', 'invalid-response', 'REMOTE_INVALID_RESPONSE', 'invalid-response');
    await connectAndAssert('network', 'unreachable', 'REMOTE_UNAVAILABLE', 'network-error');
    await setLanguage('en'); await shot('unreachable-en-mocked', true);
    await connectAndAssert('empty', 'connected', null, 'valid-empty-response');
    await page.locator('#remoteConnectionClose').click(); await expect(page.locator('#emptyState')).toBeVisible();
    matrix.at(-1).emptyStateText = await page.locator('#emptyState').innerText();
    await shot('empty-library-en-mocked', true); await openSettings();
    checks.push('Synthetic HTTP 401/403/404/503, malformed response and network failure retain zero cards and explicit error states. Only a validated synthetic 200 empty library reaches connected and shows the empty-library message.');

    stage = 'real-readonly-public-probe'; await mode('public');
    const beforePublic = (await state()).calls.length;
    const response = await page.evaluate(() => window.portraitStudio.chooseLibrary());
    const publicState = await state(); expect(publicState.calls.length).toBe(beforePublic + 1);
    publicProbe = { synthetic: false, endpoint: recommendedEndpoint, method: 'GET', route: '/portrait-studio/v1/library', authenticated: false, ipcOk: response.ok, errorCode: response.error?.code || null, observed: publicState.calls.at(-1), connectionSettings: await page.evaluate(() => window.portraitStudio.connectionSettings()) };
    expect(publicProbe.observed.mode).toBe('public');
    expect(publicState.rejectedRequests).toBe(0);
    checks.push('One real unauthenticated public library GET is recorded separately; its observed result is not substituted with the synthetic status matrix.');

    stage = 'restart-address-persistence'; await closeOwned(); await launch(); await openSettings();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#remoteEndpoint')).toHaveValue(recommendedEndpoint);
    await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-unreachable$/);
    restart = { settings: await page.evaluate(() => window.portraitStudio.connectionSettings()), state: await state(), configuration: fileConfiguration(), uiStatus: await page.locator('#remoteConnectionStatus').innerText() };
    expect(restart.settings.ok).toBe(true); expect(restart.settings.data.source).toBe('saved'); expect(restart.settings.data.endpoint).toBe(recommendedEndpoint); expect(restart.settings.data.authorizationProvided).toBe(false);
    expect(restart.configuration).toEqual(configSaved); expect(restart.state.calls).toHaveLength(1);
    expect(await page.locator('.portrait-card').count()).toBe(0);
    await shot('persisted-unreachable-en-mocked', true);
    checks.push('A new owned Electron process restores the exact address-only configuration and language, performs the required library GET, and keeps failed transport disconnected with no local cards.');
    expect(errors).toEqual([]); await closeOwned();
    realLibraryAfter = libraryTree(); expect(realLibraryAfter).toEqual(realLibraryBefore);
    expect(launches.every(value => value.closed && value.processGone)).toBe(true);
    checks.push('Both test-owned processes closed; all real local library files, item count and revision remain byte-for-byte unchanged.');
    stage = 'complete'; writeReport('passed');
    console.log(JSON.stringify({ status: 'passed', report: reportPath, checks: checks.length, publicProbe: { ok: publicProbe.ipcOk, errorCode: publicProbe.errorCode, status: publicProbe.observed.status || null }, realLibraryUnchanged: true, screenshots: screenshots.length, ownedProcessesClosed: launches.every(value => value.closed && value.processGone) }));
  } catch (error) {
    if (app) { try { lastMainState = await state(); } catch (snapshotError) { diagnostics.push({ operation: 'last-main-state', code: snapshotError.code || snapshotError.name }); } }
    console.error(error); process.exitCode = 1;
    try { await closeOwned(); } catch (closeError) { diagnostics.push({ operation: 'close-owned', code: closeError.code || closeError.name }); }
    try { realLibraryAfter = libraryTree(); } catch (readError) { diagnostics.push({ operation: 'read-real-library-after', code: readError.code || readError.name }); }
    writeReport('failed', { error: error.stack });
  } finally { if (app) { try { await closeOwned(); } catch (closeError) { diagnostics.push({ operation: 'final-close-owned', code: closeError.code || closeError.name }); writeReport('failed', { error: 'Owned test app cleanup failed' }); } } }
}
main();
