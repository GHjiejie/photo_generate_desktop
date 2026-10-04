'use strict';

// Real native/HTTP acceptance. There is deliberately no default endpoint:
// all mutations require a separately started empty server with a unique label.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { RemoteClient, validateEndpoint } = require('../remote-client.cjs');
const { PNG } = require('pngjs');
const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const baseURL = process.env.PORTRAIT_STUDIO_REMOTE_TEST_BASE_URL;
const libraryLabel = process.env.PORTRAIT_STUDIO_REMOTE_TEST_LIBRARY_LABEL;
const authorization = process.env.PORTRAIT_STUDIO_REMOTE_TEST_AUTHORIZATION;
if (!baseURL || !/^remote-native-(?:test|final)-[a-zA-Z0-9_-]{8,100}$/.test(libraryLabel || '')) {
  throw new Error('An explicit test endpoint and unique remote-native-test-* or remote-native-final-* library label are required; production/default endpoints are forbidden.');
}
const endpoint = validateEndpoint(baseURL, true);
const kind = process.env.PORTRAIT_STUDIO_REMOTE_TEST_NAME || `remote-native-${version}`;
if (!/^remote-[a-zA-Z0-9._-]+$/.test(kind)) throw new Error('The evidence name must be a remote-* filename component.');
const output = path.join(project, '.verification');
const reportPath = path.join(output, `${kind}-verification.json`);
const resumeAfterCAS = process.env.PORTRAIT_STUDIO_REMOTE_TEST_RESUME_AFTER_CAS === '1';
const previousReportPath = path.join(output, `${kind}-shortcut-focus-failure.json`);
const previousReportBytes = resumeAfterCAS ? fs.readFileSync(previousReportPath) : null;
const previousReport = previousReportBytes ? JSON.parse(previousReportBytes) : null;
const screenshotsOnly = process.env.PORTRAIT_STUDIO_REMOTE_TEST_SCREENSHOTS_ONLY === '1';
const coreReportPath = path.join(output, `${kind}-core-pass-before-viewport-correction.json`);
const coreReportBytes = screenshotsOnly ? fs.readFileSync(coreReportPath) : null;
const coreReport = coreReportBytes ? JSON.parse(coreReportBytes) : null;
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-remote-native-')));
const profile = path.join(temporary, 'isolated-profile');
const source = path.join(temporary, 'single-directory-source');
const sourceImages = path.join(source, 'images');
for (const directory of [output, profile, sourceImages]) fs.mkdirSync(directory, { recursive: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const formalRoot = fs.realpathSync(path.join(project, 'photo_repo'));
const formalIndex = JSON.parse(fs.readFileSync(path.join(formalRoot, '.portrait-studio/library.json')));
const persistentLocks = new Set(['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json']);
function fingerprint(root) {
  const result = {};
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (persistentLocks.has(name)) continue;
      expect(entry.isSymbolicLink(), `ordinary preserved path ${name}`).toBe(false);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) { const bytes = fs.readFileSync(path.join(root, name)); result[name] = { size: bytes.length, sha256: sha(bytes) }; }
      else throw new Error(`Unsupported persistent file: ${name}`);
    }
  }
  visit(); return result;
}
function treeSummary(files) { return { files: Object.keys(files).length, bytes: Object.values(files).reduce((sum, item) => sum + item.size, 0), treeSha256: sha(JSON.stringify(files)) }; }
const formalBefore = fingerprint(formalRoot);
const originalItems = formalIndex.items.slice(0, 5);
expect(originalItems).toHaveLength(5);
const fixtures = originalItems.map((item, index) => {
  const filename = path.join(index < 3 ? sourceImages : temporary, `native-fixture-${index + 1}.png`);
  const original = fs.realpathSync(path.join(formalRoot, item.imageRel));
  expect(path.relative(formalRoot, original).startsWith('..')).toBe(false);
  const bytes = fs.readFileSync(original);
  expect(sha(bytes)).toBe(item.sha256);
  fs.writeFileSync(filename, bytes, { flag: 'wx' });
  return { filename, sha256: item.sha256, size: bytes.length, prompts: clone(item.prompts) };
});
const records = fixtures.slice(0, 3).map((fixture, index) => ({
  id: index + 1, image: `images/${path.basename(fixture.filename)}`,
  label: `Remote batch fixture ${index + 1}`, type: index === 2 ? 'art' : 'photo',
  prompt_en: fixture.prompts.en, prompt_cn: fixture.prompts.zh,
  custom: { fixture: true, ordinal: index, literal: '<script>globalThis.__remoteInjected=true</script>' }
}));
const manifestBytes = Buffer.from(`${JSON.stringify(records, null, 2)}\n`);
fs.writeFileSync(path.join(source, 'manifest.json'), manifestBytes, { flag: 'wx' });
const sourceBefore = fingerprint(source);
const client = new RemoteClient({ baseURL, authorization, allowLoopback: true });
const optionalStore = process.env.PORTRAIT_STUDIO_REMOTE_TEST_STORE_DIR;
let storeRoot;
if (optionalStore) {
  storeRoot = fs.realpathSync(optionalStore);
  if (!storeRoot.includes('remote-native-') || storeRoot === formalRoot) throw new Error('Optional filesystem evidence must refer to a dedicated remote-native-* test store.');
}
const checks = [], screenshots = [], copies = [], errors = [], security = [], phases = [], ipcChecks = [];
let app, page, stage = 'prepared', initial, final, events = [], recovery, deletionItem, continuation;
const substitutions = {
  nativePicker: 'Only test-owned dialog.showOpenDialog results are queued; actual IPC, canonical source validation, uploads, server planning and durable transactions remain in use. Interactive macOS picker operation is not tested.',
  clipboard: 'Only test-owned main clipboard.writeText/readText use an in-memory buffer. The production copy-prompt IPC handler remains in use. The OS clipboard is never read or written.',
  observation: 'Test-owned RemoteClient prototype wrappers call and return the original methods unchanged, recording real HTTP results and upload hashes. No HTTP response or server operation is mocked.',
  recovery: 'The API returns a durable recovery identifier but exposes no restore endpoint. Recovery image/record bytes are checked when an explicit local test-store path is supplied; remote files otherwise need an independent server audit.'
};
function report(status, extra = {}) {
  const formalAfter = fingerprint(formalRoot), sourceAfter = fingerprint(source);
  const value = { status, version, kind, stage, project, endpoint, libraryLabel, temporary, profile, source, storeRoot,
    initial, final, recovery, continuation, security, phases, checks, screenshots, copies, ipcChecks, events, errors, substitutions,
    localLibrary: { path: formalRoot, before: treeSummary(formalBefore), after: treeSummary(formalAfter), unchanged: JSON.stringify(formalBefore) === JSON.stringify(formalAfter) },
    sourceFiles: { before: treeSummary(sourceBefore), after: treeSummary(sourceAfter), unchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter) }, ...extra };
  fs.writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`); return value;
}
function unwrap(value) { expect(value?.ok, JSON.stringify(value)).toBe(true); return value.data; }
async function bridge(method, value) {
  return page.evaluate(({ method, value }) => window.portraitStudio[method](value), { method, value });
}
async function snapshot() {
  const value = unwrap(await bridge('libraryList'));
  expect(value.root, 'every native mutation targets the unique test server').toBe(libraryLabel);
  expect(value.remote).toBe(true); expect(value.configured).toBe(true); expect(value.writable).toBe(true);
  return value;
}
async function closeOwnedApp() { if (app) { await app.close(); app = undefined; } }
async function launch() {
  const env = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile, PORTRAIT_STUDIO_REMOTE_BASE_URL: baseURL };
  delete env.PORTRAIT_STUDIO_LIBRARY_DIR;
  delete env.PORTRAIT_STUDIO_REMOTE_AUTHORIZATION;
  if (authorization) env.PORTRAIT_STUDIO_REMOTE_AUTHORIZATION = authorization;
  app = await electron.launch({ executablePath: require('electron'), args: [project], env });
  page = await app.firstWindow();
  // OS work-area constraints may clamp the native window. Explicit Chromium
  // viewport emulation fixes renderer/screenshot geometry without OS changes.
  await page.setViewportSize({ width: 1440, height: 920 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ clipboard, dialog, BrowserWindow, app }, args) => {
    globalThis.__remoteClipboard = ''; globalThis.__remoteClipboardWrites = [];
    clipboard.writeText = value => { globalThis.__remoteClipboard = String(value); globalThis.__remoteClipboardWrites.push({ text: String(value), stack: new Error().stack }); };
    clipboard.readText = () => globalThis.__remoteClipboard;
    globalThis.__remoteDialogQueue = []; globalThis.__remoteDialogCalls = []; globalThis.__remoteEvents = [];
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__remoteDialogCalls.push(options);
      if (!globalThis.__remoteDialogQueue.length) throw new Error('Unexpected test-owned native picker');
      return globalThis.__remoteDialogQueue.shift();
    };
    const mainRequire = process.getBuiltinModule('module').createRequire(args.project + '/main.js');
    const { RemoteClient } = mainRequire(args.project + '/remote-client.cjs');
    const { createHash } = mainRequire('node:crypto');
    globalThis.__remoteGetInFlight = 0;
    const originalGet = RemoteClient.prototype.get;
    RemoteClient.prototype.get = async function (...parameters) {
      globalThis.__remoteGetInFlight++;
      try { return await originalGet.apply(this, parameters); }
      finally { globalThis.__remoteGetInFlight--; }
    };
    for (const method of ['mutate', 'preview', 'commit', 'cancel']) {
      const original = RemoteClient.prototype[method];
      RemoteClient.prototype[method] = async function (...parameters) {
        const event = { method, started: Date.now() };
        if (method === 'mutate') event.operation = parameters[0];
        if (method === 'preview') event.upload = {
          manifestRelativePath: parameters[0].manifestRelativePath,
          manifestSha256: createHash('sha256').update(parameters[0].manifestBytes).digest('hex'),
          images: parameters[0].images.map(image => ({ relativePath: image.relativePath, size: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex') }))
        };
        if (method === 'commit' || method === 'cancel') event.remotePreviewId = parameters[0];
        globalThis.__remoteEvents.push(event);
        try { const result = await original.apply(this, parameters); event.result = result; return result; }
        catch (error) { event.error = error.code || error.message; throw error; }
        finally { event.finished = Date.now(); }
      };
    }
    return app.getPath('userData');
  }, { project });
  const prefs = await app.evaluate(({ BrowserWindow, app }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { pid: process.pid, packaged: app.isPackaged, userData: app.getPath('userData'), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity };
  });
  expect(prefs.userData).toBe(profile); expect(prefs.packaged).toBe(false);
  expect(prefs.sandbox).toBe(true); expect(prefs.contextIsolation).toBe(true);
  expect(prefs.nodeIntegration).toBe(false); expect(prefs.webSecurity).toBe(true);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await page.evaluate(() => window.portraitStudio.backend)).toBe('remote');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'"); expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain('portrait-media:'); expect(csp).not.toContain('unsafe-eval');
  security.push({ ...prefs, csp });
  await expect.poll(async () => (await snapshot()).items.length).toBe((await client.list()).items.length);
}
async function getEvents() { return app.evaluate(() => globalThis.__remoteEvents); }
async function menuAction(id) {
  if (!await page.locator('#libraryMenuPanel').isVisible()) await page.locator('#libraryMenuToggle').click();
  await expect(page.locator(`#${id}`)).toBeEnabled(); await page.locator(`#${id}`).click();
}
async function closeDetail() {
  if (await page.locator('#closeDialog').isVisible()) await page.locator('#closeDialog').click();
  await expect(page.locator('#detailDialog')).not.toBeVisible();
}
async function language(value) {
  await closeDetail();
  if (!await page.locator('#settingsPanel').isVisible()) await page.locator('#settingsToggle').click();
  await page.locator(`#uiLanguage button[data-language="${value}"]`).click();
  await page.locator('#settingsToggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', value === 'zh' ? 'zh-CN' : 'en');
}
async function picker(filename, action) {
  const before = await app.evaluate(() => globalThis.__remoteDialogCalls.length);
  await app.evaluate((_electron, choice) => globalThis.__remoteDialogQueue.push(choice), filename ? { canceled: false, filePaths: [filename] } : { canceled: true, filePaths: [] });
  await action();
  await expect.poll(() => app.evaluate(() => globalThis.__remoteDialogQueue.length)).toBe(0);
  expect(await app.evaluate(() => globalThis.__remoteDialogCalls.length)).toBe(before + 1);
  return app.evaluate(() => globalThis.__remoteDialogCalls.at(-1));
}
async function decodeImages() {
  const images = await page.locator('.portrait-image').evaluateAll(async values => {
    await Promise.all(values.map(async image => { image.loading = 'eager'; await image.decode(); }));
    return values.map(image => ({ src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight }));
  });
  for (const image of images) { expect(image.src).toMatch(/^portrait-media:\/\/asset\//); expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0); }
  return images;
}
async function shot(name) {
  const filename = `${kind}-${name}-1440x920.png`;
  await page.mouse.move(0, 0); await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
  const pixels = PNG.sync.read(fs.readFileSync(path.join(output, filename)));
  screenshots.push({ filename, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), pixels: { width: pixels.width, height: pixels.height } });
}
async function fillEditor(value) {
  if (value.id != null) await page.locator('#portraitId').fill(String(value.id));
  if (value.label != null) await page.locator('#portraitLabel').fill(value.label);
  if (value.prompts) { await page.locator('#portraitPromptEn').fill(value.prompts.en); await page.locator('#portraitPromptZh').fill(value.prompts.zh); }
}
async function openDetail(id) {
  await page.locator(`.portrait-card[data-id="${id}"]`).click();
  await expect(page.locator('#detailDialog')).toBeVisible();
  await page.locator('#detailImage').evaluate(image => image.decode());
}
async function captureCopy(action, item, locale, label) {
  await expect.poll(() => app.evaluate(() => globalThis.__remoteGetInFlight)).toBe(0);
  await app.evaluate(() => { globalThis.__remoteClipboard = 'memory sentinel'; });
  const before = await app.evaluate(() => globalThis.__remoteClipboardWrites.length);
  await action();
  await expect.poll(() => app.evaluate(() => globalThis.__remoteClipboard)).toBe(item.prompts[locale]);
  await expect.poll(() => app.evaluate(() => globalThis.__remoteGetInFlight)).toBe(0);
  const writes = await app.evaluate((_electron, before) => globalThis.__remoteClipboardWrites.slice(before), before);
  expect(writes, 'one explicit copy action reaches the main clipboard once').toHaveLength(1);
  for (const write of writes) {
    expect(write.text).toBe(item.prompts[locale]);
    expect(write.stack, 'every copy goes through the production remote copy-prompt handler').toMatch(/remote-electron\.cjs/);
  }
  copies.push({ label, id: item.id, language: locale, revision: item.revision, characters: writes[0].text.length, sha256: sha(writes[0].text), writeCount: writes.length, via: 'production copy-prompt IPC; in-memory main clipboard' });
}
async function copyItem(item) {
  for (const locale of ['zh', 'en']) {
    await language(locale); await openDetail(item.id);
    await expect(page.locator('#detailPrompt')).toHaveText(item.prompts[locale]);
    await captureCopy(() => page.locator('#detailCopy').click(), item, locale, `detail-${item.id}-${locale}`);
    await captureCopy(async () => {
      await page.locator('#detailDialog').evaluate(dialog => dialog.focus());
      expect(await page.evaluate(() => document.activeElement.id)).toBe('detailDialog');
      await page.keyboard.press('Meta+Enter');
    }, item, locale, `shortcut-${item.id}-${locale}`);
    await shot(`detail-${item.id}-${locale}`); await closeDetail();
    await captureCopy(() => page.locator(`.portrait-card[data-id="${item.id}"] .copy-button`).click(), item, locale, `card-${item.id}-${locale}`);
  }
}
async function chooseBatchUI() {
  await menuAction('libraryBatch'); await expect(page.locator('#batchImportDialog')).toBeVisible();
  const options = await picker(source, () => page.locator('#batchChooseDirectory').click());
  expect(options.properties).toEqual(['openDirectory']);
  await expect(page.locator('#batchDirectoryPath')).toHaveText(source);
  await expect(page.locator('#batchManifestPath')).toHaveText('manifest.json');
  await expect(page.locator('#batchManifestCandidate')).toHaveCount(0);
  await expect(page.locator('#batchPreview')).toBeEnabled();
  await page.locator('#batchPreview').click(); await expect(page.locator('#batchSummary')).toBeVisible();
  await expect(page.locator('#batchChooseDirectory')).toBeEnabled();
  return (await getEvents()).filter(event => event.method === 'preview').at(-1);
}
async function phase(name, action) {
  stage = name; console.log(JSON.stringify({ phase: name, status: 'started' }));
  await action(); phases.push({ phase: name, completed: new Date().toISOString() });
  report('in-progress'); console.log(JSON.stringify({ phase: name, status: 'passed' }));
}
async function main() {
  try {
    initial = await client.list();
    expect(initial.root, 'unique dedicated test namespace required before launching native writes').toBe(libraryLabel);
    expect(initial.writable).toBe(true);
    if (screenshotsOnly) {
      expect(coreReport.status).toBe('passed'); expect(coreReport.libraryLabel).toBe(libraryLabel);
      expect(initial.revision).toBe(coreReport.final.revision); expect(initial.items).toHaveLength(3);
      const stored = items => items.map(({ image_url, ...item }) => item);
      expect(stored(initial.items)).toEqual(stored(coreReport.final.items));
      const before = storeRoot ? fingerprint(storeRoot) : null;
      initial = coreReport.initial; recovery = coreReport.recovery; continuation = clone(coreReport.continuation);
      continuation.readonlyViewportCorrection = { priorReportPath: coreReportPath, priorReportSha256: sha(coreReportBytes), nativeWorkArea: { width: 1440, height: 865 }, correctedViewport: { width: 1440, height: 920 }, method: 'Playwright page.setViewportSize; no macOS settings changed' };
      phases.push(...coreReport.phases); checks.push(...coreReport.checks); copies.push(...coreReport.copies); security.push(...coreReport.security); ipcChecks.push(...coreReport.ipcChecks); events.push(...coreReport.events);
      for (const screenshot of coreReport.screenshots) screenshots.push({ ...screenshot, pixels: clone(screenshot.viewport), legacyFilenameMismatch: screenshot.viewport.height !== 920 });
      await phase('readonly-1440x920-screenshot-correction', async () => {
        await launch(); await expect(page.locator('.portrait-card')).toHaveCount(3); await decodeImages();
        expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1440, height: 920 });
        final = await snapshot(); const selected = final.items.find(item => item.sourceImport.sourceId === 2);
        for (const locale of ['zh', 'en']) {
          await language(locale); await shot(`viewport-gallery-${locale}`);
          await openDetail(selected.id); await expect(page.locator('#detailPrompt')).toHaveText(selected.prompts[locale]);
          await shot(`viewport-detail-${selected.id}-${locale}`); await closeDetail();
        }
        if (before) expect(fingerprint(storeRoot)).toEqual(before);
        expect(fingerprint(formalRoot)).toEqual(formalBefore); expect(fingerprint(source)).toEqual(sourceBefore);
        expect(errors).toEqual([]);
        checks.push('Read-only screenshot continuation verifies exact 1440×920 renderer and PNG dimensions in both languages; original work-area-clamped 1440×865 images are explicitly marked. Server persistent bytes remain unchanged.');
      });
      for (const screenshot of screenshots.slice(-4)) expect(screenshot.pixels).toEqual({ width: 1440, height: 920 });
      stage = 'complete'; report('passed');
      console.log(JSON.stringify({ status: 'passed', report: reportPath, mode: 'readonly-screenshot-continuation', count: final.items.length, revision: final.revision, screenshots: screenshots.slice(-4) }));
      return;
    }
    let single;
    if (resumeAfterCAS) {
      expect(previousReport.status).toBe('failed'); expect(previousReport.stage).toBe('native-edit-CAS-review');
      expect(previousReport.libraryLabel).toBe(libraryLabel); expect(previousReport.endpoint.endpoint).toBe(endpoint.endpoint);
      expect(previousReport.error).toContain('Expected length: 1'); expect(previousReport.error).toContain('Received length: 2');
      const previousEdit = previousReport.events.filter(event => event.method === 'mutate' && event.operation === 'update' && event.result).at(-1).result;
      expect(initial.items).toHaveLength(1); expect(initial.revision).toBe(previousEdit.snapshot.revision);
      const current = initial.items[0];
      expect(current.id).toBe(1); expect(current.label).toBe('Remote native CAS reviewed'); expect(current.sha256).toBe(fixtures[4].sha256);
      expect(current.prompts).toEqual({ en: `${fixtures[3].prompts.en}\nNative remote CAS draft: exact retained final line.`, zh: `${fixtures[3].prompts.zh}\n原生远程 CAS 草稿：完整保留的末行。` });
      const { image_url: currentURL, ...currentStored } = current;
      const { image_url: previousURL, ...previousStored } = previousEdit.item;
      expect(currentStored).toEqual(previousStored);
      continuation = { previousReportPath, previousReportSha256: sha(previousReportBytes), reason: 'Continue after a test callback used the injected Electron argument as the clipboard slice offset and therefore inspected all historical writes. Correct callback signature now selects only this action. Earlier duplicate/late-language interpretations were not product evidence.', verifiedCount: 1, verifiedRevision: initial.revision, verifiedItemSha256: current.sha256 };
      phases.push(...previousReport.phases); checks.push(...previousReport.checks); security.push(...previousReport.security); ipcChecks.push(...previousReport.ipcChecks); events.push(...previousReport.events);
      initial = previousReport.initial;
      await phase('native-CAS-continuation-copy', async () => {
        await launch(); await expect(page.locator('.portrait-card')).toHaveCount(1); await decodeImages();
        single = unwrap(await bridge('libraryGet', 1)).item; await copyItem(single);
        await app.evaluate(() => { globalThis.__remoteClipboard = 'stale-copy sentinel'; });
        expect(await bridge('copyPrompt', { id: 1, revision: single.revision - 1, language: 'en' })).toBe(false);
        expect(await app.evaluate(() => globalThis.__remoteClipboard)).toBe('stale-copy sentinel');
        checks.push('Prior native CAS edit was confirmed by exact persisted revision, metadata, complete retained draft and replacement-image hash. Continuation verifies full native Chinese/English copy from detail/card/dialog-focused shortcut and rejects stale-copy revisions.');
      });
    } else {
    expect(initial.items, 'test server must start empty; production data cannot be exercised').toHaveLength(0);
    await phase('native-connect', async () => {
      await launch(); await expect(page.locator('.portrait-card')).toHaveCount(0);
      await menuAction('libraryConfigure');
      expect((await snapshot()).items).toHaveLength(0);
      expect(await app.evaluate(() => globalThis.__remoteDialogCalls.length), 'remote reconnection uses the server, not a local library picker').toBe(0);
      checks.push('Actual remote library list and reconnect use the unique empty test server; isolated profile and native security settings verified.');
    });
    await phase('native-create-and-cancel', async () => {
      await menuAction('libraryCreate'); await expect(page.locator('#portraitEditor')).toBeVisible();
      await picker(null, () => page.locator('#portraitChooseImage').click());
      await expect(page.locator('#portraitChooseImage')).toBeEnabled();
      await picker(fixtures[3].filename, () => page.locator('#portraitChooseImage').click());
      await page.locator('#portraitImagePreview').evaluate(image => image.decode());
      await fillEditor({ id: 1, label: 'Remote native create', prompts: fixtures[3].prompts });
      await page.locator('#portraitCancel').click(); await expect(page.locator('#portraitEditor')).not.toBeVisible();
      expect((await snapshot()).items).toHaveLength(0);
      await menuAction('libraryCreate');
      await picker(fixtures[3].filename, () => page.locator('#portraitChooseImage').click());
      await expect(page.locator('#portraitChooseImage')).toBeEnabled();
      await fillEditor({ id: 1, label: 'Remote native create', prompts: fixtures[3].prompts });
      await page.locator('#portraitSave').click(); await expect(page.locator('#portraitEditor')).not.toBeVisible();
      await expect(page.locator('.portrait-card')).toHaveCount(1);
      single = unwrap(await bridge('libraryGet', 1)).item;
      expect(single.prompts).toEqual(fixtures[3].prompts); expect(single.sha256).toBe(fixtures[3].sha256);
      await decodeImages();
      checks.push('Actual native image selection/upload/create persists exact PNG and complete bilingual prompts; canceled picker/editor leave the server unchanged.');
    });
    await phase('native-edit-CAS-review', async () => {
      await openDetail(1); await page.locator('#detailEdit').click(); await expect(page.locator('#portraitEditor')).toBeVisible();
      const before = await snapshot();
      const draft = { label: 'Remote native CAS reviewed', prompts: { en: `${single.prompts.en}\nNative remote CAS draft: exact retained final line.`, zh: `${single.prompts.zh}\n原生远程 CAS 草稿：完整保留的末行。` } };
      await fillEditor(draft);
      await picker(fixtures[4].filename, () => page.locator('#portraitChooseImage').click());
      await expect(page.locator('#portraitChooseImage')).toBeEnabled();
      await page.locator('#portraitImagePreview').evaluate(image => image.decode());
      // This concurrent change uses the same genuine renderer/main/server route.
      unwrap(await bridge('updatePortrait', { id: 1, label: 'Concurrent server edit', type: single.type, prompts: single.prompts, expectedVersion: before.revision, expectedRevision: single.revision }));
      await page.locator('#portraitSave').click();
      await expect(page.locator('#portraitReviewConflict')).toBeVisible();
      await expect(page.locator('#portraitPromptEn')).toHaveValue(draft.prompts.en);
      await expect(page.locator('#portraitPromptZh')).toHaveValue(draft.prompts.zh);
      await expect(page.locator('#portraitSave')).toBeDisabled();
      await page.locator('#portraitReviewConflict').click(); await page.locator('#portraitAcknowledgeConflict').click();
      await expect(page.locator('#portraitSave')).toBeEnabled(); await page.locator('#portraitSave').click();
      await expect(page.locator('#portraitEditor')).not.toBeVisible(); await closeDetail();
      single = unwrap(await bridge('libraryGet', 1)).item;
      expect(single.prompts).toEqual(draft.prompts); expect(single.label).toBe(draft.label); expect(single.sha256).toBe(fixtures[4].sha256);
      const stable = await snapshot();
      const stale = await bridge('updatePortrait', { id: 1, label: 'Forbidden stale overwrite', type: single.type, prompts: single.prompts, expectedVersion: before.revision, expectedRevision: single.revision });
      expect(stale.ok).toBe(false); expect(stale.error.code).toBe('CONFLICT'); expect(await snapshot()).toEqual(stable);
      ipcChecks.push({ operation: 'stale update', code: stale.error.code });
      await copyItem(single);
      await app.evaluate(() => { globalThis.__remoteClipboard = 'stale-copy sentinel'; });
      expect(await bridge('copyPrompt', { id: 1, revision: single.revision - 1, language: 'en' })).toBe(false);
      expect(await app.evaluate(() => globalThis.__remoteClipboard)).toBe('stale-copy sentinel');
      checks.push('Native edit keeps the full draft during a genuine concurrent CAS conflict; explicit review/acknowledgement permits metadata, prompt and exact replacement-image save. Stale update/copy cannot overwrite state or clipboard.');
    });
    }
    await phase('directory-upload-preview-cancel', async () => {
      const stable = await snapshot();
      await language('zh');
      const preview = await chooseBatchUI();
      expect(preview.result.total).toBe(3); expect(preview.result.matched).toBe(3); expect(preview.result.importable).toBe(3);
      expect(preview.upload.manifestSha256).toBe(sha(manifestBytes));
      expect(preview.upload.images.map(image => image.relativePath).sort()).toEqual(records.map(record => record.image).sort());
      for (const image of preview.upload.images) expect(image.sha256).toBe(sourceBefore[image.relativePath].sha256);
      expect(await snapshot()).toEqual(stable);
      await shot('single-directory-preview-zh');
      await page.locator('#batchCancel').click(); await expect(page.locator('#batchImportDialog')).not.toBeVisible();
      expect(await snapshot()).toEqual(stable);
      let error;
      try { await client.commit(preview.result.previewId, { confirmed: true, expectedVersion: stable.revision }); } catch (caught) { error = caught.code; }
      expect(['INVALID_BATCH_SELECTION', 'PREVIEW_EXPIRED']).toContain(error);
      ipcChecks.push({ operation: 'commit canceled real server preview', code: error });
      checks.push('One native folder picker discovers root manifest plus nested PNGs; exact original manifest/image bytes are uploaded to the actual Go preview. Preview and cancel preserve library state and invalidate the server lease.');
    });
    let imported;
    await phase('directory-UI-confirmed-commit', async () => {
      const preview = await chooseBatchUI();
      await expect(page.locator('#batchConfirm')).toBeEnabled(); await page.locator('#batchConfirm').click();
      await expect(page.locator('#batchReport')).toBeVisible();
      const committed = (await getEvents()).filter(event => event.method === 'commit' && event.result).at(-1).result;
      expect(committed.report.imported).toBe(3); expect(committed.report.skipped).toBe(0);
      expect(committed.snapshot.items).toHaveLength(4);
      await shot('single-directory-report-zh');
      await page.locator('#batchCancel').click(); await expect(page.locator('#batchImportDialog')).not.toBeVisible();
      const state = await snapshot(); expect(state.items).toHaveLength(4);
      expect(state.items.find(item => item.id === 1).sha256).toBe(single.sha256);
      imported = state.items.filter(item => item.id !== 1);
      for (const item of imported) {
        const raw = records.find(record => record.id === item.sourceImport.sourceId);
        expect(raw).toBeTruthy(); expect(item.sourceMetadata).toEqual(raw);
        expect(item.prompts).toEqual({ en: raw.prompt_en, zh: raw.prompt_cn });
        expect(item.sha256).toBe(sourceBefore[raw.image].sha256);
        expect(item.sourceImport.sourceRelativePath).toBe(raw.image);
        expect(item.sourceImport.manifestSha256).toBe(sha(manifestBytes));
      }
      expect(preview.result.importable).toBe(3); await decodeImages();
      checks.push('Actual UI confirmation commits three server portraits atomically, allocates colliding internal IDs, and retains original source IDs, raw metadata, exact images and complete prompts.');
    });
    await phase('directory-repeat-idempotence', async () => {
      const stable = await snapshot(); const filesBefore = storeRoot ? fingerprint(storeRoot) : null;
      const preview = await chooseBatchUI();
      expect(preview.result.importable).toBe(0); expect(preview.result.skipped).toBe(3);
      await expect(page.locator('#batchConfirm')).toBeDisabled(); await shot('single-directory-repeat-zh');
      await page.locator('#batchCancel').click(); await expect(page.locator('#batchImportDialog')).not.toBeVisible();
      let selection;
      await picker(source, async () => { selection = unwrap(await bridge('chooseBatchDirectory')); });
      const repeatedPreview = unwrap(await bridge('previewBatch', { directorySelectionId: selection.selectionId, manifestCandidateId: selection.manifests[0].candidateId, type: 'photo' }));
      expect(repeatedPreview.importable).toBe(0); expect(repeatedPreview.skipped).toBe(3);
      const denied = await bridge('commitBatch', { previewId: repeatedPreview.previewId, confirmed: false, expectedVersion: repeatedPreview.revision });
      expect(denied.ok).toBe(false); expect(denied.error.code).toBe('CONFIRMATION_REQUIRED');
      const stale = await bridge('commitBatch', { previewId: repeatedPreview.previewId, confirmed: true, expectedVersion: repeatedPreview.revision - 1 });
      expect(stale.ok).toBe(false); expect(stale.error.code).toBe('CONFLICT');
      const repeated = unwrap(await bridge('commitBatch', { previewId: repeatedPreview.previewId, confirmed: true, expectedVersion: repeatedPreview.revision }));
      expect(repeated.report.imported).toBe(0); expect(repeated.report.skipped).toBe(3);
      expect(repeated.snapshot.revision).toBe(stable.revision); expect(repeated.report.archiveRel).toBeFalsy();
      unwrap(await bridge('cancelBatch', { previewId: repeatedPreview.previewId, directorySelectionId: selection.selectionId }));
      ipcChecks.push({ operation: 'repeat commit requires confirmation and current version', denied: denied.error.code, stale: stale.error.code, imported: repeated.report.imported, skipped: repeated.report.skipped });
      expect(await snapshot()).toEqual(stable);
      if (filesBefore) expect(fingerprint(storeRoot)).toEqual(filesBefore);
      checks.push('Repeated UI upload recognizes all three image hashes and disables import; genuine IPC repeat commit skips all three with no index, image, archive or revision changes. Unconfirmed/stale commits are rejected.');
    });
    await phase('native-delete-recovery', async () => {
      await page.locator('#searchInput').fill(''); await openDetail(1);
      await page.locator('#detailDelete').click(); await expect(page.locator('#deleteConfirmDialog')).toBeVisible();
      const stable = await snapshot(); await page.locator('#deleteCancel').click();
      expect(await snapshot()).toEqual(stable);
      await page.locator('#detailDelete').click(); await page.locator('#deleteConfirm').click();
      await expect(page.locator('#deleteConfirmDialog')).not.toBeVisible();
      await expect(page.locator('.portrait-card')).toHaveCount(3);
      deletionItem = single;
      const deleted = (await getEvents()).filter(event => event.method === 'mutate' && event.operation === 'remove' && event.result).at(-1).result;
      expect(deleted.deletedId).toBe(1); expect(deleted.recoveryId).toMatch(/^[0-9a-f-]{36}$/);
      recovery = { id: deleted.recoveryId, sourceItem: deletionItem, imageSha256: fixtures[4].sha256, apiIdentifierVerified: true, fileBytesVerified: false };
      if (storeRoot) {
        const directory = path.join(storeRoot, '.portrait-studio/recovery', deleted.recoveryId);
        const { image_url, ...persistedItem } = deletionItem;
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'item.json')))).toEqual(persistedItem);
        expect(sha(fs.readFileSync(path.join(directory, deletionItem.image)))).toBe(deletionItem.sha256);
        recovery.fileBytesVerified = true;
      }
      checks.push('Native delete cancellation preserves the record; explicit delete removes only the dedicated server record and returns its durable recovery identifier.');
    });
    events.push(...await getEvents()); await closeOwnedApp();
    await phase('native-process-restart-search-copy', async () => {
      await launch(); await expect(page.locator('.portrait-card')).toHaveCount(3);
      final = await snapshot(); expect(final.items).toHaveLength(3);
      const decoded = await decodeImages(); expect(decoded).toHaveLength(3);
      await language('zh'); await shot('gallery-zh');
      const selected = final.items.find(item => item.sourceImport.sourceId === 2);
      await page.locator('#searchInput').fill(selected.label); await expect(page.locator('.portrait-card')).toHaveCount(1);
      await page.locator('#searchInput').fill('no-such-native-remote-match'); await expect(page.locator('.portrait-card')).toHaveCount(0);
      await page.locator('#searchInput').fill(''); await expect(page.locator('.portrait-card')).toHaveCount(3);
      await copyItem(selected); await language('en'); await shot('gallery-en');
      expect(await page.evaluate(() => globalThis.__remoteInjected)).toBeUndefined();
      checks.push('A new native process restores the server list, decodes every remote PNG, filters/searches records and copies full Chinese/English prompts through the actual main handler from detail, shortcut and card controls.');
    });
    events.push(...await getEvents());
    expect(fingerprint(formalRoot)).toEqual(formalBefore); expect(fingerprint(source)).toEqual(sourceBefore);
    expect(errors).toEqual([]);
    stage = 'complete'; report('passed');
    console.log(JSON.stringify({ status: 'passed', report: reportPath, count: final.items.length, copies: copies.length, screenshots: screenshots.length, recoveryId: recovery.id, recoveryBytesVerified: recovery.fileBytesVerified }));
  } catch (error) {
    if (app) { try { events.push(...await getEvents()); } catch {} }
    report('failed', { error: error.stack }); console.error(error); process.exitCode = 1;
  } finally { await closeOwnedApp(); }
}
main();
