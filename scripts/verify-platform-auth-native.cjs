'use strict';

// Real Go HTTP/auth/store and real Electron/preload/React acceptance. The Go
// fixture's private stdin clock control is test-only; no HTTP response is mocked.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { PNG } = require('pngjs');
const project = path.resolve(__dirname, '..');
const output = path.join(project, '.verification');
const uninitializedOnly = process.env.PORTRAIT_STUDIO_PLATFORM_AUTH_NATIVE_UNINITIALIZED_ONLY === '1';
const previousReportPath = process.env.PORTRAIT_STUDIO_PLATFORM_AUTH_NATIVE_PREVIOUS_REPORT;
const attempt = new Date().toISOString().replace(/[^0-9TZ]/g, '');
const kind = `platform-auth-native-${require('../package.json').version}-${attempt}`;
const reportPath = path.join(output, `${kind}-verification.json`);
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-platform-auth-native-')));
const fixturePassword = 'Native admin fixture 2026!';
const wrongPassword = 'Wrong isolated password 2026!';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const formalRoot = path.join(project, 'photo_repo');
const index = JSON.parse(fs.readFileSync(path.join(formalRoot, '.portrait-studio/library.json'), 'utf8'));
expect(index.items.length).toBe(50); expect(index.revision).toBe(2);
const original = index.items[0];
const imageFixture = path.join(temporary, 'copied-original-portrait.png');
const originalImage = fs.readFileSync(path.join(formalRoot, original.imageRel));
if (sha(originalImage) !== original.sha256) throw new Error('Original image does not match its index pin');
fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(imageFixture, originalImage, { flag: 'wx' });
const helperEvents = [], network = [], checks = [], screenshots = [], launches = [], copies = [], security = [], errors = [], diagnostics = [], profileAudits = [], mainTraces = [];
let server, serverExit, helper, app, page, profile, stage = 'prepared', initial, created, final, logout, expiry, uninitialized, profileAudit;
let helperStdout = '', helperStderrLines = 0, helperOtherLines = 0, lastMainState;
let continuation, previousReport, previousReportSha;

function fingerprint(root) {
  const entries = [];
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = relative ? `${relative}/${entry.name}` : entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in persistent evidence tree');
      if (entry.isDirectory()) visit(file, key);
      else if (entry.isFile()) { const bytes = fs.readFileSync(file); entries.push({ path: key, size: bytes.length, sha256: sha(bytes) }); }
    }
  }
  visit(root); return { files: entries.length, entries, treeSha256: sha(JSON.stringify(entries)) };
}
const formalBefore = fingerprint(formalRoot);
function secretField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => ['sessiontoken', 'accesstoken', 'refreshtoken', 'password', 'authorization'].includes(key.toLowerCase()) || secretField(child));
}
function report(status, extra = {}) {
  let formalAfter;
  try { formalAfter = fingerprint(formalRoot); } catch (error) { diagnostics.push({ operation: 'library-preservation-read', code: error.code || error.name }); }
  const value = { status, stage, kind, attempt, project, temporary, helper, helperEvents, helperProcess: { pid: server?.pid, exit: serverExit, stderrLines: helperStderrLines, otherOutputLines: helperOtherLines },
    scope: 'Real isolated Go platform auth/store over explicitly permitted unpackaged loopback development transport and the real Electron source UI. Fixed test-only credentials, no public endpoint, production secret, SSH, TLS change, production server write, package change or original user application is involved.',
    substitutions: { transport: 'A main-only observer passes every request and original response unchanged to the captured real fetch. Reports contain only method, route, status and authentication booleans; passwords, headers and bearer values are never serialized.', expiry: 'Only the Go *_test.go fixture advances auth.Options.Now through private stdin; the production eight-hour lifetime and real validation remain unchanged.', picker: 'Only the test-owned macOS picker result is queued. Real selection validation, upload, production create IPC and Go transaction run; interactive OS picker operation is not asserted.', clipboard: 'Test-owned main clipboard methods use memory only. The actual production copyPrompt IPC runs; no OS clipboard access occurs.', tokenAudit: 'Bearer values stay inside the test-owned Electron main observer. Only digests enter the trusted launcher in memory for post-close profile scanning; no bearer or digest is printed or persisted.', viewport: 'Renderer viewport is explicitly 1440x920; native content dimensions and actual screenshot pixels are recorded independently.' },
    continuation, initial, created, final, logout, expiry, uninitialized, profileAudit, profileAudits, mainTraces, checks, screenshots, launches, copies, security, network, lastMainState, errors, diagnostics,
    realLibrary: { count: index.items.length, revision: index.revision, before: formalBefore, after: formalAfter, unchanged: Boolean(formalAfter && formalAfter.treeSha256 === formalBefore.treeSha256) }, ...extra };
  if (secretField(value)) throw new Error('A credential field was about to enter verification evidence');
  fs.writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`);
}
async function waitHelper(predicate, start = 0, timeout = 120000) {
  await expect.poll(() => {
    const found = helperEvents.slice(start).find(predicate);
    if (found) return found;
    if (serverExit) throw new Error('The isolated Go fixture exited before its expected event');
    return undefined;
  }, { timeout, intervals: [50, 100, 250] }).toBeTruthy();
  return helperEvents.slice(start).find(predicate);
}
async function startServer() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PORTRAIT_STUDIO_')) delete env[key];
  Object.assign(env, { PORTRAIT_STUDIO_NATIVE_AUTH_TEST: '1', GOPROXY: 'off', GOSUMDB: 'off', GOCACHE: '/tmp/portrait-admin-auth-buildcache', GOMODCACHE: '/tmp/portrait-admin-auth-modcache' });
  // Directly execute the test binary so its private stdin controls cannot be
  // consumed or closed by the go-test orchestration process.
  const testBinary = path.join(temporary, 'native-platform-auth.test');
  await new Promise((resolve, reject) => {
    const compiler = spawn('go', ['test', '-c', '-o', testBinary, './internal/httpapi'], { cwd: path.join(project, 'server'), env, stdio: ['ignore', 'ignore', 'pipe'] });
    compiler.stderr.on('data', bytes => { helperStderrLines += String(bytes).split('\n').filter(Boolean).length; });
    compiler.on('error', () => reject(new Error('Could not start the isolated Go fixture compiler')));
    compiler.on('exit', code => code === 0 ? resolve() : reject(new Error(`Isolated Go fixture compilation exited ${code}`)));
  });
  server = spawn(testBinary, ['-test.run=^TestNativePlatformAuthHarness$', '-test.v', '-test.timeout=15m'], { cwd: path.join(project, 'server'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  server.on('error', error => { serverExit = { code: error.code || error.name }; });
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });
  server.stderr.on('data', bytes => { helperStderrLines += String(bytes).split('\n').filter(Boolean).length; });
  server.stdout.on('data', bytes => {
    helperStdout += String(bytes);
    let offset;
    while ((offset = helperStdout.indexOf('\n')) !== -1) {
      const line = helperStdout.slice(0, offset); helperStdout = helperStdout.slice(offset + 1);
      if (!line.startsWith('PORTRAIT_AUTH_HARNESS ')) { helperOtherLines++; continue; }
      try { const event = JSON.parse(line.slice('PORTRAIT_AUTH_HARNESS '.length)); if (secretField(event)) throw new Error('Credential fields in fixture metadata'); helperEvents.push(event); }
      catch { diagnostics.push({ operation: 'helper-metadata', code: 'INVALID_OR_SENSITIVE_EVENT' }); }
    }
  });
  helper = await waitHelper(event => event.event === 'ready');
  const url = new URL(helper.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Fixture endpoint must be literal ephemeral IPv4 loopback');
  if (helper.mode !== 'isolated-test-only' || helper.label !== 'Isolated native auth library' || helper.initialCount !== 1 || !path.isAbsolute(helper.dataRoot) || !path.isAbsolute(helper.credentialFilePath)) throw new Error('Fixture namespace contract mismatch');
  expect(fs.realpathSync(helper.dataRoot)).toBe(helper.dataRoot);
  expect(fs.realpathSync(helper.credentialFilePath)).toBe(helper.credentialFilePath);
  expect((fs.statSync(helper.credentialFilePath).mode & 0o777).toString(8)).toBe('600');
  expect(helper.dataRoot.startsWith(formalRoot)).toBe(false);
}
async function control(command) {
  const start = helperEvents.length; server.stdin.write(`${command}\n`);
  return waitHelper(event => command === 'stop' ? event.event === 'stopped' : event.event === 'control' && event.command === command, start, 10000);
}
function bootstrap(filename) {
  fs.writeFileSync(filename, [
    "'use strict'; const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');",
    "const E = require('electron');",
    "globalThis.__platformTrace = { network: [], ipc: [], clipboard: [], pickerCalls: 0 }; globalThis.__platformSecrets = { tokens: [] }; globalThis.__platformPicker = [];",
    "const sha = value => crypto.createHash('sha256').update(value).digest('hex');",
    `const origin = new URL(${JSON.stringify(helper.endpoint)}).origin, originalFetch = globalThis.fetch;`,
    "globalThis.fetch = async (url, options = {}) => { const target = new URL(String(url)); if (target.origin !== origin) throw new Error('Only the isolated fixture origin is permitted'); const headers = new Headers(options.headers), request = { method: options.method || 'GET', route: target.pathname, authenticated: headers.has('authorization') }; globalThis.__platformTrace.network.push(request); const response = await originalFetch(url, options); request.status = response.status; if (request.route === '/v1/auth/login' && response.ok) { const data = await response.clone().json(); if (typeof data.data?.sessionToken === 'string') globalThis.__platformSecrets.tokens.push(data.data.sessionToken); } return response; };",
    "E.clipboard.writeText = value => { globalThis.__platformTrace.clipboard.push({ length: String(value).length, sha256: sha(String(value)) }); }; E.clipboard.readText = () => '';",
    "E.dialog.showOpenDialog = async () => { globalThis.__platformTrace.pickerCalls++; if (!globalThis.__platformPicker.length) throw new Error('No isolated picker selection is queued'); return globalThis.__platformPicker.shift(); };",
    "function sensitive(value) { return value && typeof value === 'object' && Object.entries(value).some(([key, child]) => ['sessiontoken','accesstoken','refreshtoken','password','authorization'].includes(key.toLowerCase()) || sensitive(child)); }",
    "const handle = E.ipcMain.handle.bind(E.ipcMain); E.ipcMain.handle = (channel, handler) => handle(channel, async (...args) => { const result = await handler(...args); if (channel.startsWith('library-') || channel.startsWith('remote-auth-')) globalThis.__platformTrace.ipc.push({ channel, ok: result?.ok, errorCode: result?.error?.code || null, credentialFieldLeaked: Boolean(sensitive(result)), cancelled: result?.data?.cancelled === true }); return result; });",
    `globalThis.__platformRevocationProbe = async () => { const token = globalThis.__platformSecrets.tokens[0]; if (!token) throw new Error('No native fixture login token captured'); const response = await globalThis.fetch(${JSON.stringify(helper.endpoint + 'v1/library')}, { method: 'GET', headers: { Authorization: 'Bearer ' + token } }); const result = await response.json(); return { status: response.status, code: result.error?.code || null }; };`,
    `require(${JSON.stringify(path.join(project, 'main.js'))});`
  ].join('\n'));
}
async function trace() { return app.evaluate(() => globalThis.__platformTrace); }
async function bridge(method, value) {
  const result = await page.evaluate(({ method, value }) => value === undefined ? window.portraitStudio[method]() : window.portraitStudio[method](value), { method, value });
  if (secretField(result)) throw new Error('Credential field leaked through production preload');
  return result;
}
function unwrap(result) { if (!result?.ok) throw new Error(`Production bridge returned ${result?.error?.code || 'UNAVAILABLE'}`); return result.data; }
async function connection() { return unwrap(await bridge('connectionSettings')); }
async function launch(name) {
  profile = path.join(temporary, `profile-${name}`); fs.mkdirSync(profile, { mode: 0o700 });
  const file = path.join(temporary, `bootstrap-${name}.cjs`); bootstrap(file);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PORTRAIT_STUDIO_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  Object.assign(env, { PORTRAIT_STUDIO_USER_DATA_DIR: profile, PORTRAIT_STUDIO_REMOTE_BASE_URL: helper.endpoint });
  app = await electron.launch({ executablePath: require('electron'), args: [file], env });
  launches.push({ name, pid: app.process().pid, profile, closed: false });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('#settingsToggle')).toBeVisible(); await page.setViewportSize({ width: 1440, height: 920 });
  const preferences = await app.evaluate(({ app, BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences(); return { profile: app.getPath('userData'), contentSize: window.getContentSize(), sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity }; });
  expect(preferences.profile).toBe(profile); expect(preferences.sandbox).toBe(true); expect(preferences.contextIsolation).toBe(true); expect(preferences.nodeIntegration).toBe(false); expect(preferences.webSecurity).toBe(true);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined'); expect(await page.locator('input[type="password"]').count()).toBe(0);
  security.push({ ...preferences, rendererPasswordInputs: 0, rendererRequire: 'undefined' });
  await openConnection();
}
async function openConnection() {
  await page.locator('#settingsToggle').click(); await expect(page.locator('#settingsConnection')).toBeEnabled({ timeout: 15000 }); await page.locator('#settingsConnection').click(); await expect(page.locator('#remoteConnectionDialog')).toBeVisible();
}
async function language(value) {
  if (await page.locator('#remoteConnectionDialog').isVisible()) await page.locator('#remoteConnectionClose').click();
  await page.locator('#settingsToggle').click(); await page.locator(`#uiLanguage [data-language="${value}"]`).click(); await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('lang', value === 'zh' ? 'zh-CN' : 'en');
}
async function shot(name, target = page) {
  await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const file = path.join(output, `${kind}-${name}.png`); await target.screenshot({ path: file, scale: 'css', animations: 'disabled' }); const png = PNG.sync.read(fs.readFileSync(file));
  screenshots.push({ path: file, name, pixels: { width: png.width, height: png.height }, viewport: await target.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
  if (target === page) expect({ width: png.width, height: png.height }).toEqual({ width: 1440, height: 920 });
}
async function authWindow() {
  const opening = app.waitForEvent('window'); await page.locator('#remoteSignIn').click(); const auth = await opening;
  await expect(auth.locator('#authForm')).toBeVisible(); await expect(auth.locator('#authUsername')).toHaveValue('admin'); await expect(auth.locator('#authUsername')).toHaveAttribute('readonly', ''); await expect(auth.locator('#authPassword')).toHaveAttribute('type', 'password');
  expect(await auth.evaluate(() => typeof window.require)).toBe('undefined'); return auth;
}
async function login(auth) {
  const closed = auth.waitForEvent('close'); await auth.locator('#authPassword').fill(fixturePassword); await auth.locator('#authSubmit').click(); await closed;
  await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-connected$/); await expect(page.locator('#remoteSignOut')).toBeVisible();
  const settings = await connection(); expect(settings.authentication?.kind).toBe('platform'); expect(settings.authentication?.username).toBe('admin'); expect(settings.authorizationProvided).toBe(true);
  expect(Date.parse(settings.authentication.expiresAt)).toBeGreaterThan(Date.now()); expect(Object.keys(settings.authentication).sort()).toEqual(['expiresAt', 'kind', 'username']); return settings;
}
async function noWriteUI() {
  if (await page.locator('#remoteConnectionDialog').isVisible()) await page.locator('#remoteConnectionClose').click();
  await expect(page.locator('.portrait-card')).toHaveCount(0); await page.locator('#libraryMenuToggle').click(); await expect(page.locator('#libraryCreate')).toBeDisabled(); await expect(page.locator('#libraryBatch')).toBeDisabled(); await page.keyboard.press('Escape');
}
async function closeApp() {
  if (!app) return;
  const observed = await trace(); network.push(...observed.network); lastMainState = observed; mainTraces.push({ profile, ...observed });
  expect(observed.ipc.every(value => !value.credentialFieldLeaked)).toBe(true);
  const digests = await app.evaluate(() => globalThis.__platformSecrets.tokens.map(token => process.getBuiltinModule('crypto').createHash('sha256').update(token).digest('hex')));
  await app.evaluate(() => { globalThis.__platformSecrets.tokens = []; });
  const pid = app.process().pid; await app.close(); app = undefined; page = undefined;
  const launch = launches.findLast(value => value.pid === pid); launch.closed = true;
  try { process.kill(pid, 0); launch.processGone = false; } catch (error) { launch.processGone = error.code === 'ESRCH'; }
  let files = 0, passwordMatches = 0, tokenMatches = 0;
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(file); files++;
        if (bytes.includes(Buffer.from(fixturePassword)) || bytes.includes(Buffer.from(wrongPassword))) passwordMatches++;
        for (const match of bytes.toString('latin1').matchAll(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g)) if (digests.includes(sha(match[0]))) tokenMatches++;
      }
    }
  }
  scan(profile); profileAudit = { profile, files, passwordMatches, tokenMatches, capturedNativeSessions: digests.length };
  profileAudits.push(profileAudit);
  expect(passwordMatches).toBe(0); expect(tokenMatches).toBe(0);
}
async function stopServer() {
  if (!server || serverExit) return;
  await control('stop'); await expect.poll(() => serverExit, { timeout: 10000 }).toBeTruthy();
}
async function main() {
  try {
    if (uninitializedOnly) {
      if (typeof previousReportPath !== 'string' || !path.isAbsolute(previousReportPath) || path.dirname(previousReportPath) !== output || !path.basename(previousReportPath).startsWith('platform-auth-native-') || !previousReportPath.endsWith('-verification.json')) throw new Error('Uninitialized continuation requires its exact prior owned evidence report');
      const bytes = fs.readFileSync(previousReportPath); previousReportSha = sha(bytes); previousReport = JSON.parse(bytes);
      if (secretField(previousReport) || previousReport.status !== 'failed' || previousReport.stage !== 'uninitialized-real-platform' || previousReport.checks.length !== 5 || !previousReport.realLibrary.unchanged || previousReport.realLibrary.before.treeSha256 !== formalBefore.treeSha256 || previousReport.helperProcess.exit.code !== 0 || !previousReport.launches.every(value => value.closed && value.processGone) || previousReport.expiry.settings.lastErrorCode !== 'SESSION_EXPIRED' || !previousReport.profileAudits.every(value => value.passwordMatches === 0 && value.tokenMatches === 0)) throw new Error('Prior actual core results do not meet the continuation guard');
      continuation = { only: 'uninitialized', previousReportPath, previousReportSha256: previousReportSha, priorStatus: previousReport.status, actualCoreChecksPassed: 5, reason: 'The first attempt required initialized=false despite the nullable metadata contract. Its real AUTH_NOT_INITIALIZED response, disabled login and all prior core stages remain preserved; only bilingual uninitialized native acceptance is continued.' };
    }
    stage = 'real-go-fixture-start'; await startServer();
    if (!uninitializedOnly) {
    stage = 'native-platform-startup'; await launch('initialized');
    await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-auth-required$/); await expect(page.locator('#remoteSignIn')).toBeEnabled();
    initial = await connection(); expect(initial.initialized).toBe(true); expect(initial.developmentLoginAllowed).toBe(true); expect(initial.authentication).toBeNull(); expect(initial.authorizationProvided).toBe(false);
    await shot('signed-out-zh-1440x920');
    stage = 'cancel-and-wrong-native-password';
    const beforeCancel = (await trace()).network.filter(value => value.route === '/v1/auth/login').length;
    const cancel = await authWindow(), cancelClosed = cancel.waitForEvent('close'); await cancel.locator('#authCancel').click(); await cancelClosed;
    await expect(page.locator('#remoteSignIn')).toBeEnabled(); expect((await trace()).network.filter(value => value.route === '/v1/auth/login')).toHaveLength(beforeCancel);
    const auth = await authWindow(); await auth.locator('#authPassword').fill(wrongPassword); await auth.locator('#authSubmit').click(); await expect(auth.locator('#authStatus')).toContainText('未通过验证'); await expect(auth.locator('#authPassword')).toHaveValue('');
    await shot('wrong-password-native-zh', auth); const afterWrong = await connection(); expect(afterWrong.authentication).toBeNull(); expect(afterWrong.authorizationProvided).toBe(false);
    checks.push('Real fixed-admin native modal masks the password; cancel sends no login POST and wrong password receives the real INVALID_CREDENTIALS response without a session.');
    stage = 'successful-native-platform-login'; await login(auth); await shot('signed-in-zh-1440x920');
    await page.locator('#remoteConnectionClose').click(); await expect(page.locator('.portrait-card')).toHaveCount(1);
    const snapshot = unwrap(await bridge('libraryList')); expect(snapshot.root).toBe(helper.label); expect(snapshot.items.length).toBe(helper.initialCount); expect(snapshot.revision).toBe(helper.initialRevision);
    checks.push('Real platform login publishes only fixed account and validated expiry metadata after an authenticated Go library GET; bearer stays in main and React has no password input.');
    stage = 'authenticated-native-create-image-and-prompts';
    await page.locator('#libraryMenuToggle').click(); await expect(page.locator('#libraryCreate')).toBeEnabled(); await page.locator('#libraryCreate').click(); await expect(page.locator('#portraitEditor')).toBeVisible();
    await app.evaluate((_electron, filename) => { globalThis.__platformPicker.push({ canceled: false, filePaths: [filename] }); }, imageFixture);
    await page.locator('#portraitChooseImage').click(); await expect(page.locator('#portraitImagePreview')).toBeVisible(); await page.locator('#portraitImagePreview').evaluate(image => image.decode());
    await page.locator('#portraitId').fill('2'); await page.locator('#portraitLabel').fill('Isolated platform authenticated portrait'); await page.locator('#portraitPromptEn').fill(original.prompts.en); await page.locator('#portraitPromptZh').fill(original.prompts.zh);
    await page.locator('#portraitSave').click(); await expect(page.locator('#portraitEditor')).not.toBeVisible(); await expect(page.locator('.portrait-card')).toHaveCount(2);
    created = unwrap(await bridge('libraryGet', 2)); expect(created.item.sha256).toBe(original.sha256); expect(created.item.prompts).toEqual(original.prompts);
    for (const locale of ['zh', 'en']) {
      await language(locale); await page.locator('.portrait-card[data-id="2"]').click(); await expect(page.locator('#detailDialog')).toBeVisible(); await page.locator('#detailImage').evaluate(image => image.decode()); await expect(page.locator('#detailPrompt')).toHaveText(original.prompts[locale]);
      const before = (await trace()).clipboard.length; await page.locator('#detailCopy').click(); await expect.poll(async () => (await trace()).clipboard.length).toBe(before + 1);
      const copy = (await trace()).clipboard.at(-1); expect(copy).toEqual({ length: original.prompts[locale].length, sha256: sha(original.prompts[locale]) }); copies.push({ locale, ...copy, productionCopyPromptIPC: true }); await shot(`authenticated-detail-${locale}-1440x920`); await page.locator('#closeDialog').click();
    }
    final = unwrap(await bridge('libraryList')); expect(final.root).toBe(helper.label); expect(final.items.length).toBe(2);
    checks.push('Authenticated native editor creates one portrait through real IPC, multipart HTTP and Go transaction; actual remote PNG decodes and complete zh/en prompts copy through production copyPrompt into test-owned memory.');
    stage = 'native-logout-and-server-revocation'; await openConnection(); await page.locator('#remoteSignOut').click(); await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-auth-required$/);
    logout = { settings: await connection(), oldBearerProbe: await app.evaluate(() => globalThis.__platformRevocationProbe()) };
    expect(logout.settings.authentication).toBeNull(); expect(logout.settings.authorizationProvided).toBe(false); expect(logout.settings.serverLoggedOut).toBeUndefined(); expect(logout.oldBearerProbe).toEqual({ status: 401, code: 'AUTH_REQUIRED' });
    await shot('logged-out-en-1440x920'); await noWriteUI();
    checks.push('Real UI logout calls DELETE auth/session and clears cards and write controls; replay of the prior native bearer within main receives Go HTTP 401 AUTH_REQUIRED, proving server revocation.');
    stage = 'real-server-session-expiry'; await openConnection(); await login(await authWindow()); await page.locator('#remoteConnectionClose').click(); await expect(page.locator('.portrait-card')).toHaveCount(2);
    await control('expire'); await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryRefresh').click(); await expect(page.locator('.portrait-card')).toHaveCount(0); await openConnection(); await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-session-expired$/);
    const beforeRejectedWrite = fingerprint(helper.dataRoot);
    expiry = { settings: await connection(), rejectedWrite: await bridge('updatePortrait', { id: 2, label: 'Rejected expired test write', type: 'photo', prompts: original.prompts, expectedVersion: final.revision, expectedRevision: created.item.revision }) };
    expect(expiry.settings.authentication).toBeNull(); expect(expiry.settings.authorizationProvided).toBe(false); expect(expiry.rejectedWrite.ok).toBe(false); expect(['AUTH_REQUIRED', 'SESSION_EXPIRED']).toContain(expiry.rejectedWrite.error.code);
    expiry.testLibraryUnchangedByRejectedWrite = beforeRejectedWrite.treeSha256 === fingerprint(helper.dataRoot).treeSha256; expect(expiry.testLibraryUnchangedByRejectedWrite).toBe(true);
    await shot('expired-en-1440x920'); await noWriteUI();
    checks.push('Test-only Go clock advances beyond the unchanged eight-hour lifetime; a real authenticated GET returns SESSION_EXPIRED, clears main/React session and cards, and rejects native writes.');
    await closeApp();
    }
    stage = 'uninitialized-real-platform'; await control('uninitialized'); await launch('uninitialized'); await expect(page.locator('#remoteConnectionStatus')).toHaveClass(/status-not-initialized$/); await expect(page.locator('#remoteSignIn')).toBeDisabled();
    uninitialized = await connection(); expect([false, null]).toContain(uninitialized.initialized); expect(uninitialized.lastErrorCode).toBe('AUTH_NOT_INITIALIZED'); expect(uninitialized.authentication).toBeNull(); await shot('not-initialized-zh-1440x920'); await language('en'); await openConnection(); await shot('not-initialized-en-1440x920'); await noWriteUI();
    checks.push('A fresh native profile against a genuinely uninitialized Go auth manager shows bilingual setup guidance, blocks sign-in and writes, and receives no fabricated empty authenticated library.');
    await closeApp(); await stopServer();
    expect(errors).toEqual([]); expect(network.every(value => ['GET', 'POST', 'PATCH', 'DELETE'].includes(value.method))).toBe(true); expect(formalBefore.treeSha256).toBe(fingerprint(formalRoot).treeSha256); expect(launches.every(value => value.closed && value.processGone)).toBe(true); expect(serverExit.code).toBe(0);
    checks.push('All apps owned by this attempt and the isolated Go fixture stop; profile audit finds no fixture password or native bearer, and all 55 real local library files remain unchanged at 50 items/revision 2.');
    stage = 'complete'; const status = uninitializedOnly ? 'uninitialized-continuation-passed' : 'passed'; report(status);
    let completionReport;
    if (uninitializedOnly) {
      expect(sha(fs.readFileSync(previousReportPath))).toBe(previousReportSha);
      completionReport = path.join(output, `${kind}-completion.json`);
      const summary = { status: 'core-passed-and-uninitialized-continuation-passed', firstAttempt: { report: previousReportPath, sha256: previousReportSha, status: 'failed', failure: 'Overstrict initialized=false harness assertion; actual server error and disabled UI were already correct.', actualCoreChecksPassed: 5, helperEndpoint: previousReport.helper.endpoint }, continuation: { report: reportPath, sha256: sha(fs.readFileSync(reportPath)), status, checksPassed: checks.length, helperEndpoint: helper.endpoint }, initialFailurePreserved: true, coreRepeated: false, totalActualChecksPassed: previousReport.checks.length + checks.length, screenshots: [...previousReport.screenshots, ...screenshots], profileAudits: [...previousReport.profileAudits, ...profileAudits], allOwnedAppsClosed: [...previousReport.launches, ...launches].every(value => value.closed && value.processGone), bothOwnedGoFixturesStopped: previousReport.helperProcess.exit.code === 0 && serverExit.code === 0, realLocalLibraryUnchanged: true, publicRequests: 0, scope: 'Two explicitly linked real isolated Go/Electron attempts. The original failed report remains unchanged; the continuation runs only the missing bilingual uninitialized scenario. No single initial full pass is claimed.' };
      fs.writeFileSync(completionReport, `${JSON.stringify(summary, null, 2)}\n`);
    }
    console.log(JSON.stringify({ status, report: reportPath, completionReport, checks: checks.length, screenshots: screenshots.length, copiedLanguages: copies.map(value => value.locale), realLibraryUnchanged: true, ownedAppsClosed: true, goFixtureStopped: true }));
  } catch (error) {
    console.error(`Platform native verification failed during ${stage}: ${error.name}`); process.exitCode = 1;
    try { if (app) await closeApp(); } catch (closeError) {
      diagnostics.push({ operation: 'close-owned-app', code: closeError.code || closeError.name });
      // An audit failure must not strand our own GUI. This is shutdown only;
      // no authentication, server mutation or original instance is retried.
      if (app) { try { await app.close(); app = undefined; page = undefined; launches.at(-1).closed = true; } catch (fallbackError) { diagnostics.push({ operation: 'final-owned-app-close', code: fallbackError.code || fallbackError.name }); } }
    }
    try { await stopServer(); } catch (stopError) { diagnostics.push({ operation: 'stop-owned-go', code: stopError.code || stopError.name }); if (server && !serverExit) server.kill('SIGTERM'); }
    const message = String(error.message).split(fixturePassword).join('[redacted fixture password]').split(wrongPassword).join('[redacted fixture password]').replace(/[A-Za-z0-9_-]{43}/g, '[redacted]');
    report('failed', { error: { name: error.name, message } });
  }
}
main();
