'use strict';

// Real Electron + production local adapter/store/transactions. All writes use
// an owned complete temporary clone; neither original library nor sources open
// as writable stores. OS picker results and clipboard are the only shims.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const local = require('./import-local-portraits.cjs');
const { project, sourceDirectory, targetDirectory, fingerprint, sha, indexRelative, ignoredLocks } = local;
const output = path.join(project, '.verification');
const previousReportPath = process.env.PORTRAIT_STUDIO_LOCAL_NATIVE_CONTINUE_REPORT;
if (previousReportPath) {
  expect(path.dirname(path.resolve(previousReportPath))).toBe(output);
  expect(path.basename(previousReportPath)).toMatch(/^local-native-1\.6\.0-[0-9TZ]+-verification\.json$/);
}
const previousReportBytes = previousReportPath ? local.ordinaryFile(previousReportPath) : null;
const previous = previousReportBytes ? JSON.parse(previousReportBytes) : null;
if (previous) {
  expect(path.dirname(path.resolve(previousReportPath))).toBe(output);
  expect(path.basename(previousReportPath)).toMatch(/^local-native-1\.6\.0-[0-9TZ]+-verification\.json$/);
  expect(previous.status).toBe('failed'); expect(previous.stage).toBe('native-crud'); expect(previous.commitSucceeded).toBe(true);
  expect(previous.checks).toHaveLength(3); expect(previous.copies).toHaveLength(16); expect(previous.screenshots).toHaveLength(4);
  expect(previous.error.message).toContain('Expected value: undefined');
  expect(previous.applications.every(value => value.closed && value.processGone)).toBe(true);
}
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const prefix = `local-native-1.6.0-${stamp}`;
const reportPath = path.join(output, `${prefix}-verification.json`);
const temporary = previous ? previous.temporary : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-local-native-')));
expect(fs.realpathSync(temporary)).toBe(temporary);
expect(path.dirname(temporary)).toBe(fs.realpathSync(os.tmpdir()));
expect(path.basename(temporary)).toMatch(/^portrait-local-native-[A-Za-z0-9]+$/);
const library = path.join(temporary, 'isolated-repository');
const profile = path.join(temporary, 'isolated-profile');
const fixtures = path.join(temporary, 'owned-bilingual-source');
const dummyLibrary = path.join(temporary, 'owned-writer-empty-library');
const sourceBefore = fingerprint(sourceDirectory), originalBefore = fingerprint(targetDirectory);
const originalIndex = JSON.parse(local.ordinaryFile(path.join(targetDirectory, indexRelative)));
expect(originalIndex.items).toHaveLength(50); expect(originalIndex.revision).toBe(2);
expect(sha(local.ordinaryFile(path.join(targetDirectory, indexRelative)))).toBe(local.originalIndexSha256);
if (!previous) {
  fs.cpSync(targetDirectory, library, { recursive: true, dereference: false, errorOnExist: true,
    filter: file => !ignoredLocks.has(path.relative(targetDirectory, file).split(path.sep).join('/')) });
  fs.mkdirSync(profile, { mode: 0o700 }); fs.mkdirSync(path.join(fixtures, 'images'), { recursive: true });
  fs.mkdirSync(dummyLibrary, { mode: 0o700 });
} else {
  expect(previous.library).toBe(library); expect(previous.profile).toBe(profile);
  expect(previous.sourceBefore).toEqual(sourceBefore); expect(previous.originalBefore).toEqual(originalBefore);
}
const sourceRecords = require('../batch-import.cjs').extractManifestRecords(JSON.parse(local.ordinaryFile(path.join(sourceDirectory, 'generated_portraits_manifest.json'))));
const approvedTranslations = JSON.parse(local.ordinaryFile(local.translationsPath)).translations;
const sourceImages = Object.keys(sourceBefore).filter(file => file.startsWith('generated_portraits/') && file.endsWith('.png')).sort();
expect(sourceImages).toHaveLength(50);
const selectedImage = path.join(temporary, 'owned-create-photo.png');
if (!previous) fs.copyFileSync(path.join(sourceDirectory, sourceImages[0]), selectedImage);
else expect(sha(local.ordinaryFile(selectedImage))).toBe(sourceBefore[sourceImages[0]].sha256);
const batchRows = [201, 202].map((id, index) => {
  const filename = `${id}-owned-bilingual.png`;
  if (!previous) fs.copyFileSync(path.join(sourceDirectory, sourceImages[index]), path.join(fixtures, 'images', filename));
  return { id, filename, label: `Owned bilingual fixture ${id}`, type: 'photo', prompt_en: `Complete owned English fixture prompt ${id}.\nPreserve original photograph bytes.`, prompt_cn: `完整的测试自有中文提示词 ${id}。\n保留原始照片字节。`, fixtureOnly: true };
});
if (!previous) fs.writeFileSync(path.join(fixtures, 'manifest.json'), `${JSON.stringify({ images: batchRows }, null, 2)}\n`);
else expect(JSON.parse(local.ordinaryFile(path.join(fixtures, 'manifest.json')))).toEqual({ images: batchRows });
const fixtureBefore = fingerprint(fixtures);
const checks = [], security = [], screenshots = [], copies = [], errors = [], applications = [], batchPreviews = [];
let app, page, stage = 'prepared', commitSucceeded = false, imported, initialImportedIndex;
let finalStatus = 'in-progress', failure;
const substitutions = {
  nativePicker: 'Test-owned dialog.showOpenDialog returns queued paths/cancellation; production parsing, IPC, CAS, validation and persistence run unchanged. Interactive macOS picker operation is untested.',
  clipboard: 'Only owned main-process clipboard.readText/writeText are in-memory; actual production copy-prompt handler is observed. No OS clipboard reads/writes.',
  externalImageOpening: 'Only owned shell.openPath acknowledges and records the verified path; no external Preview application is launched. Real shell.trashItem remains in use on one unique test-created clone image.'
};
function report(status, extra = {}) {
  fs.writeFileSync(reportPath, `${JSON.stringify({ status, stage, commitSucceeded, project, temporary, library, profile,
    originalRoot: targetDirectory, sourceDirectory, substitutions, checks, security, screenshots, copies, errors,
    applications, imported, batchPreviews, previousAttempt: previous ? { reportPath: previousReportPath,
      reportSha256: sha(previousReportBytes), status: previous.status, coreChecksPassed: previous.checks,
      copiesPassed: previous.copies, screenshots: previous.screenshots, initialFailurePreserved: true, coreRepeated: false } : undefined,
    ...extra }, null, 2)}\n`);
}
function unwrap(result) { expect(result?.ok, JSON.stringify(result)).toBe(true); return result.data; }
async function bridge(method, value) { return page.evaluate(({ method, value }) => window.portraitStudio[method](value), { method, value }); }
async function state() { return unwrap(await bridge('libraryList')); }
async function closeApp() {
  if (!app) return;
  await app.close(); app = undefined;
  const owned = applications[applications.length - 1]; owned.closed = true;
  try { process.kill(owned.pid, 0); owned.processGone = false; } catch (error) { owned.processGone = error.code === 'ESRCH'; owned.processCheck = error.code; }
}
async function launch({ persisted = false, root = library } = {}) {
  const env = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTRAIT_STUDIO_REMOTE_BASE_URL', 'PORTRAIT_STUDIO_REMOTE_AUTHORIZATION', 'PORTRAIT_STUDIO_BACKEND']) delete env[key];
  if (!persisted) env.PORTRAIT_STUDIO_LIBRARY_DIR = root;
  else delete env.PORTRAIT_STUDIO_LIBRARY_DIR;
  app = await electron.launch({ executablePath: require('electron'), args: [project], env });
  page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ clipboard, dialog, shell, BrowserWindow, app }, args) => {
    globalThis.__localNativeClipboard = ''; globalThis.__localNativeCopyCalls = [];
    clipboard.writeText = value => { globalThis.__localNativeClipboard = String(value); };
    clipboard.readText = () => globalThis.__localNativeClipboard;
    globalThis.__localNativePickerQueue = []; globalThis.__localNativePickerOptions = [];
    dialog.showOpenDialog = async (_parent, options) => {
      globalThis.__localNativePickerOptions.push(options);
      const result = globalThis.__localNativePickerQueue.shift();
      if (!result) throw new Error('Unqueued test-owned native picker');
      return result;
    };
    const mainRequire = process.getBuiltinModule('module').createRequire(args.project + '/main.js');
    const { ipcMain } = mainRequire('electron');
    globalThis.__localNativeBatchIPC = [];
    for (const channel of ['library-batch-directory-choose', 'library-batch-preview', 'library-batch-cancel', 'library-choose']) {
      const handler = ipcMain._invokeHandlers.get(channel);
      if (typeof handler !== 'function') throw new Error('Latest production local batch handler is required');
      ipcMain._invokeHandlers.set(channel, async (event, ...values) => {
        const result = await handler(event, ...values);
        globalThis.__localNativeBatchIPC.push({ channel, ok: result?.ok, errorCode: result?.error?.code,
          total: result?.data?.total, matched: result?.data?.matched, importable: result?.data?.importable }); return result;
      });
    }
    const copy = ipcMain._invokeHandlers.get('copy-prompt');
    if (typeof copy !== 'function') throw new Error('Latest local copy-prompt production handler is required');
    ipcMain._invokeHandlers.set('copy-prompt', async (event, ...values) => {
      const result = await copy(event, ...values);
      globalThis.__localNativeCopyCalls.push({ values, result, copied: globalThis.__localNativeClipboard }); return result;
    });
    const trash = shell.trashItem.bind(shell);
    globalThis.__localNativeTrash = []; globalThis.__localNativeOpened = [];
    shell.trashItem = async file => {
      if (!file.startsWith(args.library + '/assets/images/')) throw new Error('Trash must stay in owned temporary clone');
      globalThis.__localNativeTrash.push(file); return trash(file);
    };
    shell.openPath = async file => { globalThis.__localNativeOpened.push(file); return ''; };
    globalThis.__localNativeNetworkRequests = [];
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      globalThis.__localNativeNetworkRequests.push({ scheme: new URL(details.url).protocol, resourceType: details.resourceType }); callback({ cancel: true });
    });
  }, { project, library });
  const observed = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences();
    return { pid: process.pid, userData: app.getPath('userData'), isPackaged: app.isPackaged,
      contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox,
      webSecurity: prefs.webSecurity, nativeContentBounds: window.getContentBounds() };
  });
  expect(observed.userData).toBe(profile); expect(observed.isPackaged).toBe(false);
  expect(observed.contextIsolation).toBe(true); expect(observed.nodeIntegration).toBe(false);
  expect(observed.sandbox).toBe(true); expect(observed.webSecurity).toBe(true);
  applications.push({ pid: observed.pid, closed: false }); security.push(observed);
  expect(await page.evaluate(() => window.portraitStudio.backend)).toBe('local');
  expect((await state()).root).toBe(root); expect((await state()).backend).toBe('local');
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await app.evaluate(() => Object.keys(process.getBuiltinModule('module').createRequire(process.cwd() + '/main.js').cache).some(file => /\/(?:remote-electron|remote-client|auth-dialog)\.cjs$/.test(file)))).toBe(false);
  await page.waitForLoadState('networkidle');
}
async function screenshot(name) {
  const destination = path.join(output, `${prefix}-${name}-1440x920.png`);
  await page.mouse.move(0, 0); await page.screenshot({ path: destination, scale: 'css', animations: 'disabled' });
  screenshots.push({ path: destination, actualWidth: 1440, actualHeight: 920,
    viewportMechanism: 'Playwright renderer viewport override; native macOS work-area content bounds separately recorded.' });
}
async function closeDetail() { if (await page.locator('#detailDialog').isVisible()) await page.locator('#closeDialog').click(); }
async function language(value) {
  await closeDetail(); await page.locator('#settingsToggle').click();
  await page.locator(`#uiLanguage button[data-language="${value}"]`).click(); await page.locator('#settingsToggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', value === 'zh' ? 'zh-CN' : 'en');
}
async function menu(id) { await closeDetail(); await page.locator('#libraryMenuToggle').click(); await page.locator(id).click(); }
async function pick(file, action) {
  await app.evaluate((_electron, selected) => globalThis.__localNativePickerQueue.push(selected), file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] });
  await action(); await expect.poll(() => app.evaluate(() => globalThis.__localNativePickerQueue.length)).toBe(0);
}
async function recordCopy(item, language, action, label) {
  const before = await app.evaluate(() => globalThis.__localNativeCopyCalls.length);
  await app.evaluate(() => { globalThis.__localNativeClipboard = 'test-owned memory sentinel'; });
  await action();
  await expect.poll(() => app.evaluate(() => globalThis.__localNativeClipboard)).toBe(item.prompts[language]);
  const captured = await app.evaluate((_electron, index) => globalThis.__localNativeCopyCalls.slice(index), before);
  expect(captured).toHaveLength(1); expect(captured[0].values).toEqual([{ id: item.id, revision: item.revision, language }]);
  expect(captured[0].result).toBe(true); expect(captured[0].copied).toBe(item.prompts[language]);
  copies.push({ label, id: item.id, language, length: item.prompts[language].length, sha256: sha(item.prompts[language]), productionCopyPromptIPC: true });
}

(async () => {
  try {
    if (!previous) {
    stage = 'launch-local'; await launch({ root: dummyLibrary });
    await expect(page.locator('.portrait-card')).toHaveCount(0); await expect(page.locator('#remoteConnectionDialog')).toHaveCount(0);
    stage = 'native-derived-preview';
    const preview = await app.evaluate(async ({ nativeImage }, args) => {
      const mainRequire = process.getBuiltinModule('module').createRequire(args.project + '/main.js');
      const { trustedPlan } = mainRequire(args.project + '/scripts/import-local-portraits.cjs');
      const { LocalLibrary } = mainRequire(args.project + '/local-library.cjs');
      const validateImage = bytes => { const image = nativeImage.createFromBuffer(bytes), size = image.getSize(); return !image.isEmpty() && size.width > 0 && size.height > 0; };
      const prepared = await trustedPlan({ validateImage });
      const service = new LocalLibrary({ validateImage }); await service.open(args.library);
      globalThis.__localNativePrepared = prepared; globalThis.__localNativeService = service;
      return service.previewBatch(prepared.plan, { collisionPolicy: 'allocate-new' });
    }, { project, library });
    expect(preview.summary).toEqual({ total: 50, importable: 50, skipped: 0, conflicts: 0, invalid: 0 });
    expect(fingerprint(library)).toEqual(originalBefore);
    stage = 'isolated-atomic-import';
    imported = await app.evaluate(async () => {
      const value = await globalThis.__localNativeService.importBatch(globalThis.__localNativePrepared.plan, { expectedVersion: 2, confirmed: true, collisionPolicy: 'allocate-new' });
      return { count: value.items.length, revision: value.revision, batch: value.batch };
    });
    commitSucceeded = true; report('in-progress');
    expect(imported.count).toBe(100); expect(imported.revision).toBe(3); expect(imported.batch.imported).toBe(50);
    console.log(JSON.stringify({ stage, isolated: true, count: imported.count, revision: imported.revision, imported: imported.batch.imported }));
    initialImportedIndex = JSON.parse(local.ordinaryFile(path.join(library, indexRelative)));
    expect(initialImportedIndex.items.filter(row => row.id <= 50)).toEqual(originalIndex.items);
    for (const item of initialImportedIndex.items.filter(row => row.id > 50)) {
      const raw = sourceRecords.find(row => Number(row.id) === item.sourceImport.sourceId);
      expect(item.id).toBe(Number(raw.id) + 50); expect(item.sourceMetadata).toEqual(raw);
      expect(item.prompts.en).toBe(raw.prompt_en ?? raw.prompt ?? raw.prompts?.en);
      expect(item.prompts.zh).toBe(approvedTranslations[String(Number(raw.id))]);
      expect(item.sourceImport.derivedChinesePrompt).toBe(item.prompts.zh);
      expect(item.sourceImport.translationProvenance.kind).toBe('derived-translation');
      expect(item.sourceImport.translationProvenance.sourcePromptSha256).toBe(sha(item.prompts.en));
      expect(item.sourceImport.translationProvenance.translatedPromptSha256).toBe(sha(item.prompts.zh));
      expect(item.sha256).toBe(sourceBefore[item.sourceImport.sourceRelativePath].sha256);
      expect(sha(local.ordinaryFile(path.join(library, item.imageRel)))).toBe(item.sha256);
    }
    expect(fs.readFileSync(path.join(library, imported.batch.archiveRel, 'manifest.json'))).toEqual(fs.readFileSync(path.join(sourceDirectory, 'generated_portraits_manifest.json')));
    checks.push('Real nativeImage validation and atomic batch import into owned clone: 100 items/revision3, IDs51–100, source1–50, exact raw metadata/manifest/images and separately recorded derived Chinese provenance.');
    stage = 'idempotent-repeat'; const beforeRepeat = fingerprint(library);
    const repeat = await app.evaluate(async () => {
      const preview = await globalThis.__localNativeService.previewBatch(globalThis.__localNativePrepared.plan, { collisionPolicy: 'allocate-new' });
      const result = await globalThis.__localNativeService.importBatch(globalThis.__localNativePrepared.plan, { expectedVersion: 3, confirmed: true, collisionPolicy: 'allocate-new' });
      return { preview, count: result.items.length, revision: result.revision, batch: result.batch };
    });
    expect(repeat.preview.summary.skipped).toBe(50); expect(repeat.batch.imported).toBe(0); expect(repeat.batch.skipped).toBe(50);
    expect(repeat.count).toBe(100); expect(repeat.revision).toBe(3); expect(fingerprint(library)).toEqual(beforeRepeat);
    checks.push('Repeat skips all50 and changes no persistent byte, revision or archive.');
    await closeApp(); await launch(); await expect(page.locator('.portrait-card')).toHaveCount(100);
    stage = 'native-gallery-decode';
    const decoded = await page.locator('.portrait-image').evaluateAll(async images => {
      images.forEach(image => { image.loading = 'eager'; }); await Promise.all(images.map(image => image.decode()));
      return images.map(image => ({ width: image.naturalWidth, height: image.naturalHeight, source: image.currentSrc }));
    });
    expect(decoded).toHaveLength(100); expect(decoded.every(image => image.width > 0 && image.height > 0 && image.source.startsWith('portrait-media://'))).toBe(true);
    stage = 'bilingual-gallery-and-copy';
    for (const locale of ['zh', 'en']) {
      await language(locale); await page.locator('.main-content').evaluate(element => { element.scrollTop = 0; }); await screenshot(`gallery-${locale}`);
      for (const id of [51, 67, 84, 100]) {
        const item = initialImportedIndex.items.find(row => row.id === id);
        await recordCopy(item, locale, () => page.locator(`.portrait-card[data-id="${id}"] .copy-button`).click(), `card-${id}-${locale}`);
        await page.locator(`.portrait-card[data-id="${id}"]`).click(); await expect(page.locator('#detailDialog')).toBeVisible();
        await page.locator('#detailImage').evaluate(image => image.decode());
        expect(await page.locator('#detailPrompt').textContent()).toBe(item.prompts[locale]);
        await recordCopy(item, locale, () => page.locator('#detailCopy').click(), `detail-${id}-${locale}`);
        if (id === 51) await screenshot(`detail-${locale}`);
        await closeDetail();
      }
    }
    await page.locator('#searchInput').fill('rooftop');
    expect(await page.locator('.portrait-card').count()).toBeGreaterThan(0);
    await page.locator('#searchInput').fill('local-native-no-match-token'); await expect(page.locator('.portrait-card')).toHaveCount(0);
    await page.locator('#searchInput').fill(''); await expect(page.locator('.portrait-card')).toHaveCount(100);
    checks.push('All100 local PNGs decode through production portrait-media; search works; 16 card/detail copies match complete zh/en through actual copy-prompt IPC.');
    stage = 'native-crud'; await menu('#libraryCreate'); await expect(page.locator('#portraitEditor')).toBeVisible();
    await pick(null, () => page.locator('#portraitChooseImage').click());
    await page.locator('#portraitCancel').click(); expect(fingerprint(library)).toEqual(beforeRepeat);
    await menu('#libraryCreate'); await pick(selectedImage, () => page.locator('#portraitChooseImage').click());
    await page.locator('#portraitImagePreview').evaluate(image => image.decode());
    await page.locator('#portraitId').fill('101'); await page.locator('#portraitLabel').fill('Owned local native CRUD fixture');
    await page.locator('#portraitPromptEn').fill('Complete owned English CRUD prompt.\nLine two 50 mm.');
    await page.locator('#portraitPromptZh').fill('完整测试中文提示词。\n第二段 50 mm。'); await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible(); await expect(page.locator('.portrait-card')).toHaveCount(101);
    const created = (await state()).items.find(row => row.id === 101), createdVersion = (await state()).revision;
    const createdSha256 = sha(local.ordinaryFile(path.join(library, created.imageRel)));
    expect(sha(local.ordinaryFile(path.join(library, created.imageRel)))).toBe(sha(local.ordinaryFile(selectedImage)));
    await page.locator('.portrait-card[data-id="101"]').click(); await page.locator('#detailEdit').click();
    await page.locator('#portraitLabel').fill('Owned local native edited fixture'); await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    const current = await state(), edited = current.items.find(row => row.id === 101);
    const staleBefore = fingerprint(library);
    const stale = await bridge('updatePortrait', { id: 101, label: 'Rejected stale edit', type: 'photo', prompts: created.prompts, expectedVersion: createdVersion, expectedRevision: created.revision });
    expect(stale.ok).toBe(false); expect(stale.error.code).toBe('CONFLICT'); expect(fingerprint(library)).toEqual(staleBefore);
    await closeDetail(); await page.locator('.portrait-card[data-id="101"]').click(); await page.locator('#detailDelete').click();
    await page.locator('#deleteCancel').click(); expect(fingerprint(library)).toEqual(staleBefore);
    await page.locator('#detailDelete').click(); await page.locator('#deleteConfirm').click();
    await expect(page.locator('#deleteConfirmDialog')).not.toBeVisible(); await expect(page.locator('.portrait-card')).toHaveCount(100);
    expect(fs.existsSync(path.join(library, edited.imageRel))).toBe(false);
    const trash = await app.evaluate(() => globalThis.__localNativeTrash);
    expect(trash).toEqual([path.join(library, edited.imageRel)]);
    const recoveryImages = [];
    for (const directory of fs.readdirSync(path.join(library, '.portrait-studio/recovery'))) {
      const folder = path.join(library, '.portrait-studio/recovery', directory);
      for (const file of fs.readdirSync(folder)) if (file.startsWith('image.')) recoveryImages.push(sha(local.ordinaryFile(path.join(folder, file))));
    }
    expect(recoveryImages).toContain(createdSha256);
    checks.push('Actual editor/image selection/create/edit/delete/cancel IPC and stale CAS rejection; one unique clone image really moved to macOS Trash with exact recovery image preserved.');
    } else {
      stage = 'continuation-recovery-read-only';
      initialImportedIndex = JSON.parse(local.ordinaryFile(path.join(library, indexRelative)));
      expect(initialImportedIndex.items).toHaveLength(100); expect(initialImportedIndex.revision).toBe(6);
      expect(initialImportedIndex.items.filter(row => row.id <= 50)).toEqual(originalIndex.items);
      expect(initialImportedIndex.items.map(row => row.id)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      for (const item of initialImportedIndex.items.filter(row => row.id > 50)) {
        const raw = sourceRecords.find(row => Number(row.id) === item.sourceImport.sourceId);
        expect(item.id).toBe(Number(raw.id) + 50); expect(item.sourceMetadata).toEqual(raw);
        expect(item.prompts.zh).toBe(approvedTranslations[String(Number(raw.id))]);
        expect(item.sha256).toBe(sourceBefore[item.sourceImport.sourceRelativePath].sha256);
        expect(sha(local.ordinaryFile(path.join(library, item.imageRel)))).toBe(item.sha256);
      }
      const records = [], recoveryImages = [];
      for (const name of fs.readdirSync(path.join(library, '.portrait-studio/recovery'))) {
        const folder = path.join(library, '.portrait-studio/recovery', name);
        records.push(JSON.parse(local.ordinaryFile(path.join(folder, 'record.json'))));
        for (const file of fs.readdirSync(folder)) if (file.startsWith('image.')) recoveryImages.push(sha(local.ordinaryFile(path.join(folder, file))));
      }
      const deleted = records.find(record => record.operation === 'remove' || record.operation === 'delete');
      const actualImageSha = sha(local.ordinaryFile(selectedImage));
      expect(records.every(record => record.item.id === 101 && record.item.sha256 === actualImageSha)).toBe(true);
      expect(recoveryImages).toContain(actualImageSha);
      expect(records.some(record => record.operation === 'remove')).toBe(true);
      const tree = fingerprint(library);
      for (const [name, expected] of Object.entries(originalBefore)) if (name !== indexRelative) expect(tree[name]).toEqual(expected);
      commitSucceeded = true; imported = previous.imported;
      checks.push('Read-only continuation verifies exact raw recovery item/image hashes for prior completed CRUD/Trash; public snapshot intentionally omits SHA. Existing100/revision6 and every old non-index/image/source byte remain intact; no CRUD repeated.');
      await launch(); await expect(page.locator('.portrait-card')).toHaveCount(100);
    }
    // A custom media protocol is not fully represented by Playwright HTTP
    // networkidle. Finish outstanding gallery media before directory selection.
    await page.locator('.portrait-image').evaluateAll(async images => {
      images.forEach(image => { image.loading = 'eager'; }); await Promise.all(images.map(image => image.decode()));
    });
    stage = 'single-directory-preview'; await menu('#libraryBatch');
    const beforeBatch = fingerprint(library), pickerBefore = await app.evaluate(() => globalThis.__localNativePickerOptions.length);
    await pick(fixtures, () => page.locator('#batchChooseDirectory').click());
    await expect(page.locator('#batchManifestCandidate')).toHaveCount(0); await expect(page.locator('#batchManifestPath')).toContainText('manifest.json');
    await page.locator('#batchPreview').click(); await expect(page.locator('#batchSummary')).toBeVisible(); await expect(page.locator('#batchConfirm')).toBeEnabled();
    expect(await app.evaluate(() => globalThis.__localNativePickerOptions.length)).toBe(pickerBefore + 1);
    const summary = await page.locator('#batchSummary strong').allTextContents(); expect(summary.slice(0, 3)).toEqual(['2', '2', '2']);
    batchPreviews.push({ source: fixtures, syntheticBilingualMetadata: true, actualPhotos: true, pickerCalls: 1, summary });
    await screenshot('single-directory-preview'); await page.locator('#batchCancel').click();
    expect(fingerprint(library)).toEqual(beforeBatch); expect(fingerprint(fixtures)).toEqual(fixtureBefore);
    checks.push('Actual one-picker directory discovery auto-selects root JSON and nested real copied PNGs; real IPC preview2/matched2/importable2 and cancel leave no persistent changes.');
    stage = 'persisted-root-restart'; await pick(library, () => menu('#libraryConfigure'));
    await expect(page.locator('.portrait-card')).toHaveCount(100);
    expect(JSON.parse(local.ordinaryFile(path.join(profile, 'library-config.json')))).toEqual({ version: 1, root: library });
    const beforeRestart = fingerprint(library);
    const networkFirst = await app.evaluate(() => globalThis.__localNativeNetworkRequests);
    expect(networkFirst).toEqual([]);
    await closeApp(); await launch({ persisted: true });
    await expect(page.locator('.portrait-card')).toHaveCount(100);
    const restarted = await state(); expect(restarted.items).toHaveLength(100); expect(restarted.revision).toBe(6);
    for (const item of initialImportedIndex.items) {
      const current = restarted.items.find(row => row.id === item.id);
      expect(current.prompts).toEqual(item.prompts); expect(current.sourceMetadata).toEqual(item.sourceMetadata);
      expect(current.sourceImport).toEqual(item.sourceImport); expect(current.imageRel).toBe(item.imageRel);
      expect(sha(local.ordinaryFile(path.join(library, current.imageRel)))).toBe(item.sha256);
    }
    expect(fingerprint(library)).toEqual(beforeRestart);
    expect(await app.evaluate(() => globalThis.__localNativeNetworkRequests)).toEqual([]);
    checks.push('Saved canonical local root reloads after real Electron restart without library env override; all100 imported records/prompts/provenance persist. Clone revision6 includes the isolated CRUD create/edit/delete; initial import was revision3. No HTTP/HTTPS requests observed.');
    const finalTree = fingerprint(library);
    for (const [name, expected] of Object.entries(originalBefore)) if (name !== indexRelative) expect(finalTree[name]).toEqual(expected);
    expect(fingerprint(sourceDirectory)).toEqual(sourceBefore); expect(fingerprint(targetDirectory)).toEqual(originalBefore);
    stage = 'complete'; finalStatus = 'passed';
    report(finalStatus, { decodedCount: 100, finalCount: restarted.items.length, finalRevision: restarted.revision,
      realLibraryCount: originalIndex.items.length, realLibraryRevision: originalIndex.revision, original55FilesUnchanged: true, source52FilesUnchanged: true });
  } catch (error) {
    finalStatus = 'failed'; failure = { message: error.message, stack: error.stack };
    if (app) {
      failure.actualBatchIPC = await app.evaluate(() => globalThis.__localNativeBatchIPC).catch(() => []);
      failure.actualBatchError = await page.locator('#batchError').textContent().catch(() => null);
      failure.pickerOptions = await app.evaluate(() => globalThis.__localNativePickerOptions).catch(() => []);
    }
    report(finalStatus, { error: failure }); throw error;
  } finally {
    await closeApp();
    try {
      expect(fingerprint(sourceDirectory)).toEqual(sourceBefore); expect(fingerprint(targetDirectory)).toEqual(originalBefore);
      expect(fingerprint(fixtures)).toEqual(fixtureBefore);
      report(finalStatus, { error: failure, sourceBefore, sourceAfter: fingerprint(sourceDirectory), originalBefore,
        originalAfter: fingerprint(targetDirectory), original55FilesUnchanged: true, source52FilesUnchanged: true,
        decodedCount: finalStatus === 'passed' ? 100 : undefined, finalCount: finalStatus === 'passed' ? 100 : undefined,
        finalRevision: finalStatus === 'passed' ? 6 : undefined, onlyOwnedAppsClosed: true });
      console.log(JSON.stringify({ status: finalStatus, stage, reportPath, checks: checks.length, copies: copies.length,
        screenshots: screenshots.length, original55FilesUnchanged: true, source52FilesUnchanged: true, applications }));
    } catch (error) { report('failed-preservation', { error: { message: error.message, stack: error.stack } }); process.exitCode = 1; }
  }
})().catch(error => { console.error(JSON.stringify({ status: 'failed', stage, reportPath, error: error.message })); process.exitCode = 1; });
