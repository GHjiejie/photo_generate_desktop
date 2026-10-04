'use strict';

// The default run imports only into a complete temporary repository copy.
// A real import additionally requires the explicit environment flag and exact
// pre-import index hash, item count and revision guards below.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { extractManifestRecords } = require('../batch-import.cjs');
const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const realImport = process.env.PORTRAIT_STUDIO_DERIVED_REAL_IMPORT === '1';
const prefix = `derived-directory-${realImport ? 'real' : 'isolated'}-${version}`;
const output = path.join(project, '.verification');
const reportPath = path.join(output, `${prefix}-verification.json`);
const formalRoot = fs.realpathSync(path.join(project, 'photo_repo'));
expect(fs.lstatSync(path.join(project, 'photo_repo')).isSymbolicLink()).toBe(false);
expect(formalRoot).toBe(path.join(project, 'photo_repo'));
const sourceDirectory = fs.realpathSync('/Users/jie/Downloads/chinese_beauty_50_generated_images');
const manifestPath = path.join(sourceDirectory, 'generated_portraits_manifest.json');
const translationPath = process.env.PORTRAIT_STUDIO_DERIVED_TRANSLATIONS_PATH || path.join(output, 'single-directory-translations.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const indexRelative = '.portrait-studio/library.json';
const expectedIndexSha256 = 'ad0a021d698e5aa0d1ef9ff17b9fb4c57ccde585031737a293cf7b57788e100e';
const ignoredLocks = ['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json'];
const originalIndexBytes = fs.readFileSync(path.join(formalRoot, indexRelative));
const originalIndex = JSON.parse(originalIndexBytes);
expect(sha(originalIndexBytes), 'pre-import index must match the authorized original library').toBe(expectedIndexSha256);
expect(originalIndex.revision).toBe(2);
expect(originalIndex.items).toHaveLength(50);
if (realImport && fs.existsSync(reportPath)) {
  const previous = JSON.parse(fs.readFileSync(reportPath));
  if (previous.commitSucceeded) throw new Error('A real batch already committed; refuse to rerun the write. Use a separate read-only verification.');
}
const manifestBytes = fs.readFileSync(manifestPath);
const manifestSha256 = sha(manifestBytes);
const sourceRecords = extractManifestRecords(JSON.parse(manifestBytes));
expect(sourceRecords).toHaveLength(50);
expect(sourceRecords.map(item => Number(item.id)).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
const translationDocument = JSON.parse(fs.readFileSync(translationPath));
expect(translationDocument.sourceManifestSha256).toBe(manifestSha256);
const translations = translationDocument.translations;
expect(Object.keys(translations).sort((a, b) => Number(a) - Number(b))).toEqual(sourceRecords.map(item => String(item.id)).sort((a, b) => Number(a) - Number(b)));
for (const prompt of Object.values(translations)) {
  expect(typeof prompt).toBe('string'); expect(prompt.trim().length).toBeGreaterThan(0);
  expect(prompt.length).toBeLessThanOrEqual(65536); expect(prompt).toMatch(/[\u3400-\u9fff]/);
}
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `portrait-${prefix}-`)));
const targetDirectory = realImport ? formalRoot : path.join(temporary, 'isolated-library');
const dummyDirectory = path.join(temporary, 'writer-ui-dummy-library');
const profile = path.join(temporary, 'isolated-profile');
for (const directory of [output, dummyDirectory, profile]) fs.mkdirSync(directory, { recursive: true });
function fingerprint(root) {
  const entries = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (ignoredLocks.includes(name)) continue;
      expect(entry.isSymbolicLink(), `ordinary source path ${name}`).toBe(false);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) { const bytes = fs.readFileSync(path.join(root, name)); entries[name] = { size: bytes.length, sha256: sha(bytes) }; }
      else throw new Error(`Unsupported file type: ${name}`);
    }
  }
  visit(''); return entries;
}
function summary(entries) { return { files: Object.keys(entries).length, bytes: Object.values(entries).reduce((total, item) => total + item.size, 0), treeSha256: sha(JSON.stringify(entries)) }; }
const sourceBefore = fingerprint(sourceDirectory);
const formalBefore = fingerprint(formalRoot);
expect(Object.keys(sourceBefore)).toHaveLength(52);
expect(Object.keys(formalBefore)).toHaveLength(55);
if (!realImport) {
  fs.cpSync(formalRoot, targetDirectory, { recursive: true, dereference: false, errorOnExist: true, filter: file => !ignoredLocks.includes(path.relative(formalRoot, file).split(path.sep).join('/')) });
  expect(fingerprint(targetDirectory)).toEqual(formalBefore);
}
const screenshots = [], copies = [], errors = [], security = [], checks = [];
let app, page, stage = 'prepared', commitSucceeded = false, committed, repeated, newItems, targetAfter;
function writeReport(status, additions = {}) {
  const report = { status, version, realImport, stage, commitSucceeded, project, sourceDirectory, manifestPath, manifestSha256, translationPath, translationFileSha256: sha(fs.readFileSync(translationPath)), temporary, targetDirectory, dummyDirectory, profile, expectedIndexSha256, committed, repeated, security, checks, screenshots, copies, errors, ...additions };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
async function closeOwnedApp() { if (app) { await app.close(); app = undefined; } }
async function launch(libraryRoot) {
  app = await electron.launch({ executablePath: require('electron'), args: [project], env: { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile, PORTRAIT_STUDIO_LIBRARY_DIR: libraryRoot } });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ clipboard }) => {
    globalThis.__derivedClipboardText = '';
    clipboard.writeText = value => { globalThis.__derivedClipboardText = String(value); };
    clipboard.readText = () => globalThis.__derivedClipboardText;
  });
  const settings = await app.evaluate(({ app, BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { pid: process.pid, packaged: app.isPackaged, userData: app.getPath('userData'), contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
  });
  expect(settings.userData).toBe(profile); expect(settings.packaged).toBe(false);
  expect(settings.contextIsolation).toBe(true); expect(settings.sandbox).toBe(true);
  expect(settings.nodeIntegration).toBe(false); expect(settings.webSecurity).toBe(true);
  security.push(settings);
}
function english(record) { return record.prompt_en ?? record.prompt ?? record.prompts?.en; }
async function closeDetail() {
  if (await page.locator('#closeDialog').isVisible()) await page.locator('#closeDialog').click();
  await expect(page.locator('#detailDialog')).not.toBeVisible();
}
async function setLanguage(language) {
  await closeDetail();
  await page.locator('#settingsToggle').click();
  await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
  await page.locator('#settingsToggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
}
async function captureCopy(action, prompt, label) {
  await app.evaluate(({ clipboard }) => clipboard.writeText('test-owned memory sentinel'));
  await action();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(prompt);
  copies.push(label);
}
async function screenshot(name) {
  const filename = `${prefix}-${name}-1440x920.png`;
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
  screenshots.push({ filename, width: 1440, height: 920 });
}
(async () => {
  try {
    stage = 'launch-writer'; await launch(dummyDirectory);
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    stage = 'trusted-preview';
    const preview = await app.evaluate(async ({ nativeImage }, args) => {
      const mainRequire = process.getBuiltinModule('module').createRequire(args.project + '/main.js');
      const { LocalLibrary } = mainRequire(args.project + '/local-library.cjs');
      const { discoverBatchDirectory, prepareDirectoryBatchImport } = mainRequire(args.project + '/batch-import.cjs');
      const validateImage = bytes => { const image = nativeImage.createFromBuffer(bytes), size = image.getSize(); return !image.isEmpty() && size.width > 0 && size.height > 0; };
      const service = new LocalLibrary({ validateImage });
      const initial = await service.open(args.targetDirectory);
      const discovery = await discoverBatchDirectory({ directory: args.sourceDirectory });
      const plan = await prepareDirectoryBatchImport({ discovery, derivedChinesePrompts: args.translations, validateImage });
      globalThis.__derivedService = service; globalThis.__derivedPlan = plan;
      return { initial: { count: initial.items.length, revision: initial.revision }, discovery, preview: await service.previewBatch(plan, { collisionPolicy: 'allocate-new' }) };
    }, { project, targetDirectory, sourceDirectory, translations });
    expect(preview.initial).toEqual({ count: 50, revision: 2 });
    expect(preview.discovery.imageCount).toBe(50); expect(preview.discovery.manifests).toHaveLength(1);
    expect(preview.preview.summary.importable).toBe(50); expect(preview.preview.summary.conflicts).toBe(0);
    expect(fingerprint(targetDirectory)).toEqual(formalBefore);
    expect(fingerprint(sourceDirectory)).toEqual(sourceBefore);
    checks.push('trusted main-process discovery, derived translation and allocate-new preview plan 50 imports without target or source writes');
    stage = 'single-atomic-commit';
    // Recheck the write guard immediately before the transaction. Its own CAS
    // and repository lock protect the interval after this parent-side check.
    expect(sha(fs.readFileSync(path.join(targetDirectory, indexRelative)))).toBe(expectedIndexSha256);
    committed = await app.evaluate(async () => {
      const result = await globalThis.__derivedService.importBatch(globalThis.__derivedPlan, { expectedVersion: 2, confirmed: true, collisionPolicy: 'allocate-new' });
      return { count: result.items.length, revision: result.revision, batch: result.batch };
    });
    commitSucceeded = true; writeReport('in-progress', { preview });
    expect(committed.count).toBe(100); expect(committed.revision).toBe(3); expect(committed.batch.imported).toBe(50);
    console.log(JSON.stringify({ phase: 'committed', realImport, count: committed.count, revision: committed.revision, imported: committed.batch.imported, archiveRel: committed.batch.archiveRel }));
    stage = 'verify-provenance';
    const nextIndex = JSON.parse(fs.readFileSync(path.join(targetDirectory, indexRelative)));
    expect(nextIndex.items.filter(item => item.id <= 50)).toEqual(originalIndex.items);
    newItems = nextIndex.items.filter(item => item.id > 50);
    expect(newItems.map(item => item.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
    expect(newItems.map(item => item.sourceImport.sourceId).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    const archiveDirectory = path.join(targetDirectory, committed.batch.archiveRel);
    expect(fs.readFileSync(path.join(archiveDirectory, 'manifest.json'))).toEqual(manifestBytes);
    const mapping = JSON.parse(fs.readFileSync(path.join(archiveDirectory, 'mapping.json')));
    for (const item of newItems) {
      const sourceId = item.sourceImport.sourceId;
      const recordIndex = sourceRecords.findIndex(record => Number(record.id) === sourceId);
      const raw = sourceRecords[recordIndex], derived = translations[String(sourceId)];
      expect(item.sourceMetadata).toEqual(raw);
      expect(item.prompts).toEqual({ en: english(raw), zh: derived });
      expect(item.sourceImport.derivedChinesePrompt).toBe(derived);
      expect(item.sourceImport.manifestSha256).toBe(manifestSha256);
      expect(item.sourceImport.recordIndex).toBe(recordIndex);
      expect(item.sourceImport.translationProvenance).toMatchObject({ kind: 'derived-translation', sourceLanguage: 'en', targetLanguage: 'zh', sourcePromptSha256: sha(english(raw)), translatedPromptSha256: sha(derived), sourceId, recordIndex, manifestSha256 });
      const relative = item.sourceImport.sourceRelativePath;
      expect(relative).toMatch(/^generated_portraits\/[^/]+\.png$/);
      const originalImage = fs.readFileSync(path.join(sourceDirectory, relative));
      expect(fs.readFileSync(path.join(targetDirectory, item.imageRel))).toEqual(originalImage);
      expect(item.sha256).toBe(sha(originalImage)); expect(item.sourceImport.sourceHash).toBe(item.sha256);
      const archived = mapping.find(row => row.targetId === item.id);
      expect(archived).toBeTruthy();
      expect(archived.sourceId).toBe(sourceId);
      expect(archived.translationProvenance).toEqual(item.sourceImport.translationProvenance);
      expect(archived.sourceRelativePath).toBe(relative);
    }
    targetAfter = fingerprint(targetDirectory);
    for (const [relative, value] of Object.entries(formalBefore)) if (relative !== indexRelative) expect(targetAfter[relative], `old persistent file ${relative}`).toEqual(value);
    expect(fingerprint(sourceDirectory)).toEqual(sourceBefore);
    if (!realImport) expect(fingerprint(formalRoot)).toEqual(formalBefore);
    checks.push('old 50 items and all 54 non-index persistent files remain byte-identical; 50 new IDs preserve original source IDs, all raw fields, exact images, raw manifest bytes and separately labeled full derived Chinese with provenance');
    stage = 'idempotent-repeat';
    repeated = await app.evaluate(async () => {
      const preview = await globalThis.__derivedService.previewBatch(globalThis.__derivedPlan, { collisionPolicy: 'allocate-new' });
      const result = await globalThis.__derivedService.importBatch(globalThis.__derivedPlan, { expectedVersion: 3, confirmed: true, collisionPolicy: 'allocate-new' });
      return { preview, count: result.items.length, revision: result.revision, batch: result.batch };
    });
    expect(repeated.preview.summary.importable).toBe(0); expect(repeated.preview.summary.skipped).toBe(50);
    expect(repeated.batch.imported).toBe(0); expect(repeated.batch.skipped).toBe(50);
    expect(repeated.count).toBe(100); expect(repeated.revision).toBe(3);
    expect(fingerprint(targetDirectory)).toEqual(targetAfter);
    checks.push('same derived plan repeat skips all 50 and changes no persistent byte, archive or revision');
    await closeOwnedApp();
    stage = 'native-restart'; await launch(targetDirectory);
    await page.setViewportSize({ width: 1440, height: 920 });
    await expect(page.locator('.portrait-card')).toHaveCount(100);
    const decoded = await page.locator('.portrait-image').evaluateAll(async images => {
      for (const image of images) image.loading = 'eager';
      await Promise.all(images.map(image => image.decode()));
      return images.map(image => ({ source: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight, complete: image.complete }));
    });
    expect(decoded).toHaveLength(100); expect(decoded.every(image => image.complete && image.width > 0 && image.height > 0 && image.source.startsWith('portrait-media://'))).toBe(true);
    const library = await page.evaluate(() => window.portraitStudio.libraryList());
    expect(library.ok).toBe(true); expect(library.data.items).toHaveLength(100); expect(library.data.revision).toBe(3);
    for (const stored of newItems) {
      const item = library.data.items.find(row => row.id === stored.id);
      expect(item.prompts).toEqual(stored.prompts); expect(item.sourceMetadata).toEqual(stored.sourceMetadata); expect(item.sourceImport).toEqual(stored.sourceImport);
    }
    await closeDetail();
    await screenshot('native-gallery-zh');
    stage = 'native-bilingual-copy';
    for (const language of ['zh', 'en']) {
      await setLanguage(language);
      for (const id of [51, 67, 84, 100]) {
        const stored = newItems.find(item => item.id === id), prompt = stored.prompts[language];
        await page.locator(`.portrait-card[data-id="${id}"]`).click();
        await expect(page.locator('#detailDialog')).toBeVisible();
        await expect(page.locator('#detailPrompt')).toHaveText(prompt);
        await page.locator('#detailImage').evaluate(image => image.decode());
        await captureCopy(() => page.locator('#detailCopy').click(), prompt, `${id} ${language} detail button`);
        await captureCopy(() => page.keyboard.press('Meta+Enter'), prompt, `${id} ${language} detail keyboard`);
        if (id === 51 && language === 'zh' || id === 100 && language === 'en') await screenshot(`native-detail-${id}-${language}`);
        await page.keyboard.press('Escape');
        await closeDetail();
      }
    }
    await closeOwnedApp();
    expect(fingerprint(targetDirectory)).toEqual(targetAfter); expect(fingerprint(sourceDirectory)).toEqual(sourceBefore);
    if (!realImport) expect(fingerprint(formalRoot)).toEqual(formalBefore);
    expect(errors).toEqual([]);
    checks.push('full process restart loads 100 external images and complete stored provenance; all images decode and sampled new IDs 51/67/84/100 expose exact English/derived Chinese and production copy IPC captured in main-process memory');
    stage = 'complete';
    const report = writeReport('passed', { preview, decoded, newItems, unchanged: { source: { before: summary(sourceBefore), after: summary(fingerprint(sourceDirectory)), unchanged: true }, originalNonIndexFiles: Object.keys(formalBefore).length - 1, oldItems: 50, oldImages: 50, originalLibraryUnchanged: !realImport, finalTarget: summary(targetAfter) }, testSubstitutions: { import: 'The owned Electron main process invokes the production trusted planner and LocalLibrary batch service directly; renderer IPC is not expanded.', clipboard: 'Only test-owned main-process writeText/readText are replaced by a memory buffer. Production renderer copy IPC stays unchanged; the OS clipboard is never read or written.', nativePicker: 'This authorized trusted-plan transaction uses the specified directory directly; single-picker UI discovery was separately verified.' } });
    console.log(JSON.stringify({ status: report.status, realImport, reportPath, committed, repeat: { imported: repeated.batch.imported, skipped: repeated.batch.skipped }, copies: copies.length, screenshots, errors }, null, 2));
  } catch (error) {
    writeReport('failed', { error: error.stack }); throw error;
  } finally { await closeOwnedApp(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
