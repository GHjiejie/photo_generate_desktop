'use strict';

// Two real photographs only. This narrow smoke never opens the real repository
// as a store and never reads/writes the macOS clipboard. The packaged app owns
// a canonical private test profile, blank repository and bilingual fixture.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
const version = '1.6.1';
const executable = process.env.PORTRAIT_STUDIO_EXECUTABLE;
if (!executable || !path.isAbsolute(executable)) throw new Error('Explicit final1.6.1 packaged PORTRAIT_STUDIO_EXECUTABLE is required; source Electron is not a fallback.');
const executableInfo = fs.lstatSync(executable);
if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new Error('Packaged executable must be a regular file.');
const output = path.join(project, '.verification');
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const prefix = `local-packaged-${version}-${stamp}`;
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-local-packaged-')));
const library = path.join(temporary, 'blank-repository');
const profile = path.join(temporary, 'isolated-profile');
const source = path.join(temporary, 'two-real-image-source');
const reportPath = path.join(output, `${prefix}.json`);
const indexPath = path.join(library, '.portrait-studio/library.json');
const configPath = path.join(profile, 'library-config.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const readIndex = () => JSON.parse(fs.readFileSync(indexPath));
const checks = [], applications = [], security = [], screenshots = [], copies = [], errors = [], pickerResults = [], ipcResults = [];
let app, page, status = 'in-progress', stage = 'fixture-prepared', failure, commitSucceeded = false, committedRevision;
for (const dir of [library, profile, path.join(source, 'images')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const originalRoot = fs.realpathSync(path.join(project, 'photo_repo'));
const originalIndex = JSON.parse(fs.readFileSync(path.join(originalRoot, '.portrait-studio/library.json')));
const sampled = [...originalIndex.items].sort((a, b) => a.id - b.id).slice(0, 2).map((item, offset) => {
  const input = path.join(originalRoot, item.imageRel);
  if (fs.realpathSync(input) !== input || !input.startsWith(originalRoot + '/assets/images/')) throw new Error('Real sample path must be a canonical library image.');
  const bytes = fs.readFileSync(input); expect(sha(bytes)).toBe(item.sha256);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(typeof item.prompts.en).toBe('string'); expect(typeof item.prompts.zh).toBe('string');
  const id = 701 + offset, filename = `${id}-owned-real-photo.png`;
  fs.writeFileSync(path.join(source, 'images', filename), bytes, { mode: 0o600 });
  return { id, filename, label: `Owned real photo ${id}`, type: 'photo', prompt_en: item.prompts.en, prompt_cn: item.prompts.zh,
    fixtureOnly: true, originalSample: { path: input, sha256: sha(bytes), size: bytes.length, originalId: item.id } };
});
fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ images: sampled.map(({ originalSample, ...row }) => row) }, null, 2) + '\n', { mode: 0o600 });
function fingerprint(root) {
  const files = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = path.relative(root, file).split(path.sep).join('/'), info = fs.lstatSync(file);
      if (root === library && ['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json'].includes(relative)) continue;
      if (info.isSymbolicLink()) throw new Error('Unexpected symlink in owned fixture');
      if (info.isDirectory()) visit(file);
      else { if (!info.isFile()) throw new Error('Unexpected special file in owned fixture'); const bytes = fs.readFileSync(file); files[relative] = { size: bytes.length, sha256: sha(bytes) }; }
    }
  }
  visit(root); return files;
}
const sourceBefore = fingerprint(source);
function save() {
  fs.writeFileSync(reportPath, JSON.stringify({ status, stage, version, executable, executableSha256: sha(fs.readFileSync(executable)),
    project, temporary, library, profile, source, commitSucceeded, checks, applications, security, screenshots, copies, errors,
    pickerResults, ipcResults, sampledOriginalImages: sampled.map(row => row.originalSample),
    finalCount: status === 'passed' ? 2 : undefined, finalRevision: status === 'passed' ? committedRevision : undefined,
    sampledOriginalImagesUnchanged: status === 'passed' ? true : undefined,
    ownedSourceFixtureUnchanged: status === 'passed' ? true : undefined,
    persistentTreeUnchangedAfterRestart: status === 'passed' ? true : undefined,
    substitutions: {
      nativePicker: 'Only test-owned dialog.showOpenDialog results are queued. Actual packed IPC, nativeImage validation, discovery, matching, CAS, atomic commits and profile persistence are unchanged. Interactive macOS selection is untested.',
      clipboard: 'Only owned main-process clipboard.writeText/readText use a memory buffer. Actual production copy-prompt handler passes through unchanged; personal OS clipboard is never read or written.',
      metadata: 'Two intentionally isolated IDs701/702 and labels; complete authentic zh/en prompts and real existing PNG bytes are copied read-only from two library samples.',
      network: 'Test-owned HTTP/HTTPS observation cancels any unexpected request; no remote business responses or data are mocked.'
    }, error: failure }, null, 2) + '\n');
}
async function bridge(method, value) { return page.evaluate(({ method, value }) => window.portraitStudio[method](value), { method, value }); }
function unwrap(value) { expect(value?.ok, JSON.stringify(value)).toBe(true); return value.data; }
async function state() { return unwrap(await bridge('libraryList')); }
async function closeApp() {
  if (!app) return;
  let network, observerError;
  try {
    ipcResults.push(...await app.evaluate(() => globalThis.__packedSmokeIPC));
    pickerResults.push(...await app.evaluate(() => globalThis.__packedSmokePickerOptions));
    network = await app.evaluate(() => globalThis.__packedSmokeNetwork);
  } catch (error) { observerError = error; }
  const owned = applications[applications.length - 1]; await app.close(); app = undefined; owned.closed = true;
  try { process.kill(owned.pid, 0); owned.processGone = false; }
  catch (error) { owned.processGone = error.code === 'ESRCH'; owned.processCheck = error.code; }
  expect(owned.processGone).toBe(true);
  if (observerError) throw observerError;
  expect(network).toEqual([]);
}
async function launch(persisted = false) {
  const env = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'PORTRAIT_STUDIO_REMOTE_BASE_URL', 'PORTRAIT_STUDIO_REMOTE_AUTHORIZATION', 'PORTRAIT_STUDIO_BACKEND', 'PORTRAIT_STUDIO_LIBRARY_DIR']) delete env[name];
  if (!persisted) env.PORTRAIT_STUDIO_LIBRARY_DIR = library;
  app = await electron.launch({ executablePath: executable, args: [], env });
  applications.push({ pid: app.process().pid, closed: false });
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 920 });
  const observed = await app.evaluate(({ app, BrowserWindow, clipboard, dialog, ipcMain }) => {
    globalThis.__packedSmokeClipboard = ''; globalThis.__packedSmokeCopies = [];
    clipboard.writeText = value => { globalThis.__packedSmokeClipboard = String(value); };
    clipboard.readText = () => globalThis.__packedSmokeClipboard;
    globalThis.__packedSmokePickerQueue = []; globalThis.__packedSmokePickerOptions = [];
    dialog.showOpenDialog = async (_parent, options) => {
      globalThis.__packedSmokePickerOptions.push({ properties: options.properties });
      const result = globalThis.__packedSmokePickerQueue.shift(); if (!result) throw new Error('Unqueued owned picker'); return result;
    };
    globalThis.__packedSmokeIPC = [];
    for (const channel of ['library-choose', 'library-batch-directory-choose', 'library-batch-preview', 'library-batch-commit', 'library-batch-cancel']) {
      const original = ipcMain._invokeHandlers.get(channel); if (typeof original !== 'function') throw new Error('Missing actual packed local handler');
      ipcMain._invokeHandlers.set(channel, async (event, ...args) => {
        const value = await original(event, ...args);
        globalThis.__packedSmokeIPC.push({ channel, ok: value?.ok, errorCode: value?.error?.code,
          cancelled: value?.data?.cancelled, root: value?.data?.root, revision: value?.data?.revision,
          total: value?.data?.total, matched: value?.data?.matched, importable: value?.data?.importable,
          imported: value?.data?.report?.imported }); return value;
      });
    }
    const copy = ipcMain._invokeHandlers.get('copy-prompt'); if (typeof copy !== 'function') throw new Error('Missing production copy-prompt handler');
    ipcMain._invokeHandlers.set('copy-prompt', async (event, ...args) => { const value = await copy(event, ...args); globalThis.__packedSmokeCopies.push({ args, value, copied: globalThis.__packedSmokeClipboard }); return value; });
    globalThis.__packedSmokeNetwork = [];
    const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences();
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => { globalThis.__packedSmokeNetwork.push({ scheme: new URL(details.url).protocol, resourceType: details.resourceType }); callback({ cancel: true }); });
    const mainRequire = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.js');
    const packedFs = mainRequire('node:fs'), packedHash = bytes => mainRequire('node:crypto').createHash('sha256').update(bytes).digest('hex');
    return { pid: process.pid, isPackaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), userData: app.getPath('userData'),
      contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity,
      preloadPreference: prefs.preload, packedPreloadPath: app.getAppPath() + '/preload.js',
      packedPreloadSha256: packedHash(packedFs.readFileSync(app.getAppPath() + '/preload.js')),
      packedMainSha256: packedHash(packedFs.readFileSync(app.getAppPath() + '/main.js')),
      nativeContentBounds: window.getContentBounds(),
      remoteModulesLoaded: Object.keys(mainRequire.cache).some(file => /\/(?:remote-electron|remote-client|auth-dialog)\.cjs$/.test(file)) };
  });
  expect(observed.pid).toBe(applications[applications.length - 1].pid); security.push(observed);
  expect(observed.isPackaged).toBe(true); expect(observed.version).toBe(version); expect(observed.userData).toBe(profile);
  expect(observed.contextIsolation).toBe(true); expect(observed.nodeIntegration).toBe(false); expect(observed.sandbox).toBe(true); expect(observed.webSecurity).toBe(true);
  expect(observed.remoteModulesLoaded).toBe(false); expect(observed.packedPreloadPath).toBe(path.join(observed.appPath, 'preload.js'));
  expect(observed.packedPreloadSha256).toBe(sha(fs.readFileSync(path.join(project, 'preload.js'))));
  expect(observed.packedMainSha256).toBe(sha(fs.readFileSync(path.join(project, 'main.js'))));
  // Electron's getLastWebPreferences may omit preload. The packed file hashes
  // and actual sandboxed bridge/IPC checks verify the shipped preload instead.
  if (observed.preloadPreference !== undefined) expect(observed.preloadPreference).toBe(observed.packedPreloadPath);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined'); expect(await page.evaluate(() => typeof window.process)).toBe('undefined');
  expect(await page.evaluate(() => window.portraitStudio.backend)).toBe('local');
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).not.toContain('unsafe-eval');
  await expect(page.locator('#remoteConnectionDialog')).toHaveCount(0); await expect(page.locator('#remoteSignIn')).toHaveCount(0);
  const current = await state(); expect(current.root).toBe(library); expect(current.backend).toBe('local'); expect(current.writable).toBe(true);
}
async function screenshot(label) {
  const file = path.join(output, `${prefix}-${label}-1440x920.png`); await page.mouse.move(0, 0);
  await page.screenshot({ path: file, animations: 'disabled', scale: 'css' });
  screenshots.push({ path: file, actualWidth: 1440, actualHeight: 920, mechanism: 'Renderer viewport override; native macOS content bounds recorded separately.' });
}
async function menu(id) { await page.locator('#libraryMenuToggle').click(); await page.locator(id).click(); }
async function drainImages() { await page.locator('.portrait-image').evaluateAll(async images => { images.forEach(image => { image.loading = 'eager'; }); await Promise.all(images.map(image => image.decode())); }); }
async function pick(file, channel, action) {
  const count = await app.evaluate(() => globalThis.__packedSmokeIPC.length);
  await app.evaluate((_electron, file) => globalThis.__packedSmokePickerQueue.push(file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] }), file);
  await action();
  await expect.poll(() => app.evaluate((_electron, args) => globalThis.__packedSmokeIPC.slice(args.count).find(value => value.channel === args.channel), { count, channel }), { timeout: 30000 }).toBeTruthy();
  const result = await app.evaluate((_electron, args) => globalThis.__packedSmokeIPC.slice(args.count).find(value => value.channel === args.channel), { count, channel });
  expect(result.ok, JSON.stringify(result)).toBe(true); expect(await app.evaluate(() => globalThis.__packedSmokePickerQueue.length)).toBe(0);
  return result;
}
async function preview() {
  await drainImages(); await menu('#libraryBatch');
  const before = await app.evaluate(() => globalThis.__packedSmokePickerOptions.length);
  await pick(source, 'library-batch-directory-choose', () => page.locator('#batchChooseDirectory').click());
  expect(await app.evaluate(() => globalThis.__packedSmokePickerOptions.length)).toBe(before + 1);
  await expect(page.locator('#batchManifestPath')).toContainText('manifest.json'); await expect(page.locator('#batchManifestCandidate')).toHaveCount(0);
  await page.locator('#batchPreview').click(); await expect(page.locator('#batchSummary')).toBeVisible();
  expect((await page.locator('#batchSummary strong').allTextContents()).slice(0, 3)).toEqual(['2', '2', '2']);
  await expect(page.locator('#batchConfirm')).toBeEnabled();
}
async function copy(item, language, action, label) {
  const count = await app.evaluate(() => globalThis.__packedSmokeCopies.length);
  await app.evaluate(() => { globalThis.__packedSmokeClipboard = 'owned memory sentinel'; }); await action();
  await expect.poll(() => app.evaluate(() => globalThis.__packedSmokeClipboard)).toBe(item.prompts[language]);
  const rows = await app.evaluate((_electron, count) => globalThis.__packedSmokeCopies.slice(count), count);
  expect(rows).toHaveLength(1); expect(rows[0].args).toEqual([{ id: item.id, revision: item.revision, language }]); expect(rows[0].value).toBe(true);
  copies.push({ id: item.id, language, label, completeLength: item.prompts[language].length, sha256: sha(item.prompts[language]), actualMainCopyPrompt: true });
}
(async () => {
  try {
    save(); stage = 'launch-final-package'; await launch(); await expect(page.locator('.portrait-card')).toHaveCount(0);
    stage = 'save-owned-local-root';
    await pick(library, 'library-choose', () => menu('#libraryConfigure'));
    await expect.poll(() => fs.existsSync(configPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath))).toEqual({ version: 1, root: library }); expect(fs.lstatSync(configPath).mode & 0o777).toBe(0o600);
    checks.push('Final1.6.1 packed main/preload/renderer runs local without server/login; security flags, sandbox, CSP and packaged version pass. Actual library-choose completes and saves only version/root at mode600 in owned profile.');
    stage = 'single-directory-preview-cancel'; const blankBefore = fingerprint(library), blankRevision = readIndex().revision;
    await preview(); await screenshot('single-directory-preview');
    await page.locator('#batchCancel').click(); await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    expect(fingerprint(library)).toEqual(blankBefore); expect(fingerprint(source)).toEqual(sourceBefore);
    checks.push('One native directory selection automatically discovers root manifest and nested2 real PNGs; production preview total2/matched2/importable2; cancel leaves blank repository and fixture unchanged.');
    stage = 'single-directory-atomic-commit'; await preview(); await page.locator('#batchConfirm').click();
    await expect(page.locator('.portrait-card')).toHaveCount(2, { timeout: 30000 });
    await expect.poll(() => app.evaluate(() => globalThis.__packedSmokeIPC.find(value => value.channel === 'library-batch-commit' && value.ok && value.imported === 2))).toBeTruthy();
    commitSucceeded = true; save();
    if (await page.locator('#batchImportDialog').isVisible()) await page.locator('#batchCancel').click();
    await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    await drainImages();
    const committed = await state(), raw = readIndex(); expect(committed.items).toHaveLength(2); expect(committed.revision).toBe(blankRevision + 1);
    committedRevision = committed.revision;
    for (const row of sampled) {
      const item = raw.items.find(item => item.id === row.id); expect(item.sha256).toBe(row.originalSample.sha256);
      expect(item.prompts).toEqual({ en: row.prompt_en, zh: row.prompt_cn }); expect(item.sourceImport.sourceRelativePath).toBe(`images/${row.filename}`);
      expect(sha(fs.readFileSync(path.join(library, item.imageRel)))).toBe(row.originalSample.sha256);
    }
    const archive = raw.items[0].sourceImport.archiveRel; expect(fs.readFileSync(path.join(library, archive, 'manifest.json'))).toEqual(fs.readFileSync(path.join(source, 'manifest.json')));
    checks.push(`Actual packed UI commit atomically persists2 complete bilingual records/revision${committedRevision}, exact real PNGs, original JSON and source-relative paths;2 images decode through portrait-media.`);
    stage = 'complete-bilingual-copy';
    for (const language of ['zh', 'en']) {
      await page.locator('#settingsToggle').click(); await page.locator(`#uiLanguage button[data-language="${language}"]`).click(); await page.locator('#settingsToggle').click();
      await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en'); await screenshot(`gallery-${language}`);
      for (const item of committed.items) {
        const card = page.locator(`.portrait-card[data-id="${item.id}"]`);
        await copy(item, language, () => card.locator('.copy-button').click(), 'card');
        await card.locator('.portrait-image').click(); await expect(page.locator('#detailDialog')).toBeVisible();
        await page.locator('#detailImage').evaluate(image => image.decode()); expect(await page.locator('#detailPrompt').textContent()).toBe(item.prompts[language]);
        await copy(item, language, () => page.locator('#detailCopy').click(), 'detail');
        if (item.id === 701) await screenshot(`detail-${language}`); await page.locator('#closeDialog').click();
      }
    }
    expect(copies).toHaveLength(8); checks.push('Eight card/detail copies equal full authentic zh/en prompt text through actual packed copy-prompt handler; test-owned memory buffer only.');
    stage = 'saved-root-restart'; await drainImages(); const beforeRestart = fingerprint(library), configBefore = fs.readFileSync(configPath);
    await closeApp(); await launch(true); await expect(page.locator('.portrait-card')).toHaveCount(2);
    const restarted = await state(); expect(restarted.revision).toBe(committedRevision); expect(restarted.items.map(item => item.id)).toEqual([701, 702]);
    for (const expected of committed.items) {
      const item = restarted.items.find(item => item.id === expected.id);
      expect(item.prompts).toEqual(expected.prompts); expect(item.sourceMetadata).toEqual(expected.sourceMetadata); expect(item.sourceImport).toEqual(expected.sourceImport);
    }
    await drainImages(); expect(fingerprint(library)).toEqual(beforeRestart); expect(fs.readFileSync(configPath)).toEqual(configBefore);
    checks.push(`Closing/relaunching final packaged executable without library env override restores saved owned root, same2 records, revision${committedRevision}, PNGs, full prompts and metadata; persistent tree/profile config unchanged.`);
    expect(fingerprint(source)).toEqual(sourceBefore); for (const row of sampled) expect(sha(fs.readFileSync(row.originalSample.path))).toBe(row.originalSample.sha256);
    expect(errors).toEqual([]); stage = 'complete'; status = 'passed';
  } catch (error) {
    status = 'failed'; failure = { message: error.message, stack: error.stack };
    if (app) { failure.actualIPC = await app.evaluate(() => globalThis.__packedSmokeIPC).catch(() => []); failure.batchError = await page.locator('#batchError').textContent().catch(() => null); }
    process.exitCode = 1;
  } finally {
    try { await closeApp(); expect(fingerprint(source)).toEqual(sourceBefore); for (const row of sampled) expect(sha(fs.readFileSync(row.originalSample.path))).toBe(row.originalSample.sha256); }
    catch (error) { status = 'failed-cleanup-or-preservation'; failure = { previous: failure, message: error.message, stack: error.stack }; process.exitCode = 1; }
    save(); console.log(JSON.stringify({ status, stage, reportPath, checks: checks.length, copies: copies.length, screenshots: screenshots.length, applications, commitSucceeded }));
  }
})();
