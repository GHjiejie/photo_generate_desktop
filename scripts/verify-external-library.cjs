'use strict';

// Default-library reads are read-only. Every CRUD mutation and Trash call is
// restricted to a complete temporary copy, with separate user-data profiles.
const { _electron: electron, expect } = require('@playwright/test');
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const defaults = require('../assets/default-library.json');
const executable = process.env.PORTRAIT_STUDIO_EXECUTABLE;
const requestedKind = process.env.PORTRAIT_STUDIO_VERIFICATION_NAME || `${executable ? 'packaged' : 'source'}-${version}`;
if (!/^[a-zA-Z0-9._-]+$/.test(requestedKind)) throw new Error('Verification name must be a plain filename component');
const kind = requestedKind.startsWith('external-') ? requestedKind : `external-${requestedKind}`;
const output = path.join(project, '.verification');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `portrait-${kind}-`));
const defaultProfile = path.join(temporary, 'default-profile');
const copyProfile = path.join(temporary, 'copy-profile');
const missingProfile = path.join(temporary, 'missing-profile');
const copyRoot = path.join(temporary, 'copied-repository');
const emptyRoot = path.join(temporary, 'empty-repository');
const missingRoot = path.join(temporary, 'nonexistent-repository');
const checks = [], clipboardChecks = [], screenshots = [], security = [], errors = [], itemChecks = [], imageDecoding = [];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const clone = value => JSON.parse(JSON.stringify(value));
const updateMethods = ['getUpdateState', 'checkForUpdates', 'chooseUpdateSource', 'downloadUpdate', 'installUpdate', 'onUpdateState', 'acknowledgeAppReady'];
let app, page, clipboardSaved = false, formalRoot, originalIndex, formalBefore, defaultSnapshots, newId;
for (const directory of [output, defaultProfile, copyProfile, missingProfile, emptyRoot]) fs.mkdirSync(directory, { recursive: true });
// Node 25 may surface a Playwright launch failure through an internal rejected
// promise before the ordinary await catch. Preserve evidence even on that exit.
process.on('uncaughtExceptionMonitor', error => {
  fs.writeFileSync(path.join(output, `${kind}-verification.json`), json({ status: 'failed', version, kind, temporary, formalRoot, copyRoot, stage: app ? 'electron-verification' : 'electron-launch', security, itemChecks, clipboardChecks, screenshots, checks, errors, error: error.stack }));
});

function treeHashes(directory) {
  const result = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (child === path.join('.portrait-studio', 'lock.json')) continue;
      expect(entry.isSymbolicLink(), `no symlink in verified library: ${child}`).toBe(false);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(path.join(directory, child));
        result[child] = { size: bytes.length, sha256: sha(bytes) };
      } else throw new Error(`Unsupported library entry: ${child}`);
    }
  }
  visit('');
  return result;
}
function assertFormalUnchanged() {
  expect(treeHashes(formalRoot), 'all real library files and hashes remain unchanged').toEqual(formalBefore);
}
function readIndex(root) { return JSON.parse(fs.readFileSync(path.join(root, '.portrait-studio', 'library.json'), 'utf8')); }
function storedImage(root, id) {
  const item = readIndex(root).items.find(row => row.id === id);
  expect(item, `stored item ${id}`).toBeTruthy();
  const canonical = fs.realpathSync(root), file = fs.realpathSync(path.join(canonical, item.imageRel));
  const relative = path.relative(canonical, file);
  expect(!relative.startsWith('..') && !path.isAbsolute(relative)).toBe(true);
  expect(file.includes('app.asar')).toBe(false);
  const bytes = fs.readFileSync(file);
  expect(item.size).toBe(bytes.length);
  expect(item.sha256).toBe(sha(bytes));
  return { item, file, bytes, sha256: sha(bytes) };
}
function rawPrompt(record, language) {
  const fields = language === 'en' ? [record.prompt_en, record.prompt, record.prompts?.en] : [record.prompt_cn, record.prompt_zh, record.prompts?.zh];
  const values = fields.filter(value => typeof value === 'string' && value.trim());
  expect(values.length, `raw ${language} prompt exists`).toBeGreaterThan(0);
  expect(new Set(values).size, `raw ${language} aliases agree`).toBe(1);
  return values[0];
}
async function bridge(method, payload) { return page.evaluate(({ method, payload }) => window.portraitStudio[method](payload), { method, payload }); }
async function state(root, length) {
  const result = await bridge('libraryList');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.configured).toBe(true);
  expect(result.data.root).toBe(fs.realpathSync(root));
  if (length !== undefined) expect(result.data.items.length).toBe(length);
  return result.data;
}
async function closeOwnedApp() {
  if (!app) return;
  if (clipboardSaved) {
    await app.evaluate(({ clipboard }) => clipboard.write(globalThis.__portraitExternalClipboard)).catch(() => {});
    clipboardSaved = false;
  }
  await app.close();
  app = undefined;
}
async function launch(profile, options = {}) {
  const environment = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
  delete environment.PORTRAIT_STUDIO_LIBRARY_DIR;
  if (options.libraryRoot) environment.PORTRAIT_STUDIO_LIBRARY_DIR = options.libraryRoot;
  app = await electron.launch({ executablePath: executable || require('electron'), args: executable ? [] : [project], env: environment });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ clipboard, dialog, shell }, writableRoot) => {
    globalThis.__portraitExternalClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
    globalThis.__portraitExternalDialogs = [];
    globalThis.__portraitExternalTrash = [];
    dialog.showOpenDialog = async () => {
      if (!globalThis.__portraitExternalDialogs.length) throw new Error('Unexpected native picker in external-library verification');
      return globalThis.__portraitExternalDialogs.shift();
    };
    const originalTrash = shell.trashItem;
    shell.trashItem = async file => {
      // Fail closed if a production path could ever reach the mutation phase.
      if (!writableRoot || !file.startsWith(writableRoot)) throw new Error('Trash outside the isolated copy is forbidden by this test');
      await originalTrash(file);
      globalThis.__portraitExternalTrash.push({ file, success: true });
    };
  }, options.writableRoot ? fs.realpathSync(options.writableRoot) + path.sep : null);
  clipboardSaved = true;
  const settings = await app.evaluate(({ BrowserWindow, app }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { pid: process.pid, packaged: app.isPackaged, userData: app.getPath('userData'), resourcesPath: process.resourcesPath, appPath: app.getAppPath(), contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, sandbox: preferences.sandbox, webSecurity: preferences.webSecurity };
  });
  expect(settings.userData).toBe(profile);
  expect(settings.contextIsolation).toBe(true); expect(settings.nodeIntegration).toBe(false);
  expect(settings.sandbox).toBe(true); expect(settings.webSecurity).toBe(true);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  for (const method of updateMethods) expect(await page.evaluate(method => typeof window.portraitStudio[method], method)).toBe('undefined');
  await expect(page.locator('#appUpdate')).toHaveCount(0);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self'"); expect(csp).toContain("connect-src 'none'");
  expect(csp).toMatch(/img-src[^;]*portrait-media:/); expect(csp).not.toContain('unsafe-eval');
  if (settings.packaged) {
    expect(fs.existsSync(path.join(settings.resourcesPath, 'portraits'))).toBe(false);
    expect(fs.existsSync(path.join(settings.resourcesPath, 'assets', 'images'))).toBe(false);
    const asar = require('@electron/asar');
    const entries = asar.listPackage(settings.appPath);
    expect(entries.filter(entry => /\.(?:png|jpe?g|webp)$/i.test(entry)), 'app.asar contains zero gallery image files').toEqual([]);
    expect(entries.some(entry => /selected-prompts\.json|prompts\.zh\.json|assets[\\/]data\.js/.test(entry))).toBe(false);
  }
  security.push({ ...settings, csp, missingUpdateMethods: updateMethods });
}
async function selectDialog(file, action) {
  // Main intentionally refuses directory switching while protocol reads are
  // active; renderer readiness alone does not mean those image reads are idle.
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await app.evaluate((_electron, result) => globalThis.__portraitExternalDialogs.push(result), file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] });
  await action();
  await expect.poll(() => app.evaluate(() => globalThis.__portraitExternalDialogs.length)).toBe(0);
  const ready = await page.locator('#portraitEditor').isVisible() ? '#portraitChooseImage' : '#libraryConfigure';
  await expect(page.locator(ready)).toBeEnabled();
}
const languageName = language => language === 'zh' ? '中文' : 'English';
const galleryLanguage = () => page.locator('.toolbar').getByRole('group', { name: '提示词语言' });
function card(id) { return page.locator('.portrait-card').filter({ has: page.locator('.card-number', { hasText: new RegExp(`^${String(id).padStart(3, '0')}$`) }) }); }
async function copy(action, expected, label) {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), `Portrait external clipboard sentinel ${clipboardChecks.length}`);
  await action();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { message: label }).toBe(expected);
  clipboardChecks.push(label);
}
async function screenshotsOfAll() {
  const nativeSizes = await app.evaluate(({ nativeImage }, files) => files.map(({ id, file }) => {
    const image = nativeImage.createFromPath(file);
    return { id, empty: image.isEmpty(), ...image.getSize() };
  }), originalIndex.items.map(item => ({ id: item.id, file: storedImage(formalRoot, item.id).file })));
  expect(nativeSizes.every(item => !item.empty && item.width > 0 && item.height > 0)).toBe(true);
  for (const [width, height] of [[1440, 920], [2048, 1280]]) {
    await page.setViewportSize({ width, height });
    const decoded = await page.locator('.portrait-image').evaluateAll(async (images, { width }) => {
      for (const image of images) image.loading = 'eager';
      const decoded = [];
      for (const image of images) {
        let error = null;
        try { if (width === 1440) await image.decode(); } catch (failure) { error = `${failure.name}: ${failure.message}`; }
        decoded.push({ source: image.currentSrc || image.src, width: image.naturalWidth, height: image.naturalHeight, complete: image.complete, error });
      }
      return decoded;
    }, { width });
    imageDecoding.push({ width, height, decoded });
    expect(decoded.filter(item => item.error), 'all protocol images decode successfully').toEqual([]);
    expect(decoded.length).toBe(50);
    for (const [index, image] of decoded.entries()) {
      expect(image.source).toMatch(/^portrait-media:\/\/asset\/[1-9]\d*\?revision=\d+&library=\d+$/);
      expect(image.width).toBe(nativeSizes[index].width); expect(image.height).toBe(nativeSizes[index].height);
      expect(image.complete).toBe(true);
    }
    for (const dense of [false, true]) {
      if ((await page.locator('#gallery').getAttribute('class')).includes('dense') !== dense) await page.locator('#gridToggle').click();
      await page.locator('.main-content').evaluate(element => { element.scrollTop = 0; });
      await page.evaluate(() => document.activeElement?.blur());
      await page.locator('.brand-lockup').hover();
      await expect(page.locator('.portrait-card:hover')).toHaveCount(0);
      const filename = `${kind}-${width}x${height}-${dense ? 'dense' : 'normal'}.png`;
      await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
      const dimensions = PNG.sync.read(fs.readFileSync(path.join(output, filename)));
      expect(dimensions.width).toBe(width); expect(dimensions.height).toBe(height);
      screenshots.push({ filename, width, height, dense });
    }
  }
  await page.setViewportSize({ width: 1440, height: 920 });
  if ((await page.locator('#gallery').getAttribute('class')).includes('dense')) await page.locator('#gridToggle').click();
  return nativeSizes;
}
async function fillEditor(value) {
  await expect(page.locator('#portraitEditor')).toBeVisible();
  if (value.id !== undefined) await page.locator('#portraitId').fill(String(value.id));
  if (value.label !== undefined) await page.locator('#portraitLabel').fill(value.label);
  if (value.type !== undefined) await page.locator('#portraitType').selectOption(value.type);
  if (value.prompts) {
    await page.locator('#portraitPromptEn').fill(value.prompts.en);
    await page.locator('#portraitPromptZh').fill(value.prompts.zh);
  }
  if (value.id !== undefined) await expect(page.locator('#portraitId')).toHaveValue(String(value.id));
}

(async () => {
  try {
    expect(path.isAbsolute(defaults.root)).toBe(true);
    formalRoot = fs.realpathSync(defaults.root);
    expect(formalRoot).toBe(fs.realpathSync(path.join(project, 'photo_repo')));
    originalIndex = readIndex(formalRoot);
    expect(originalIndex.items.length, 'run only after the real 50-item import is ready').toBe(50);
    for (const id of [1, 25, 50]) expect(originalIndex.items.some(item => item.id === id)).toBe(true);
    formalBefore = treeHashes(formalRoot);
    for (const item of originalIndex.items) {
      const stored = storedImage(formalRoot, item.id);
      expect(item.sourceMetadata).toBeTruthy(); expect(item.sourceImport).toBeTruthy();
      const archive = fs.realpathSync(path.join(formalRoot, item.sourceImport.archiveRel));
      expect(path.relative(formalRoot, archive).startsWith('..')).toBe(false);
      const bytes = fs.readFileSync(path.join(archive, 'manifest.json'));
      expect(sha(bytes)).toBe(item.sourceImport.manifestSha256);
      const records = JSON.parse(bytes.toString('utf8'));
      expect(Array.isArray(records)).toBe(true);
      expect(item.sourceMetadata).toEqual(records[item.sourceImport.recordIndex]);
      expect(item.prompts).toEqual({ en: rawPrompt(item.sourceMetadata, 'en'), zh: rawPrompt(item.sourceMetadata, 'zh') });
      expect(item.sourceImport.sourceHash).toBe(stored.sha256);
      for (const name of ['source.json', 'mapping.json', 'report.json']) expect(fs.existsSync(path.join(archive, name))).toBe(true);
      itemChecks.push({ id: item.id, image: item.imageRel, size: stored.bytes.length, sha256: stored.sha256, enLength: item.prompts.en.length, zhLength: item.prompts.zh.length, enSha256: sha(item.prompts.en), zhSha256: sha(item.prompts.zh), sourceMetadataKeys: Object.keys(item.sourceMetadata), sourceImport: clone(item.sourceImport) });
    }
    await launch(defaultProfile);
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    let current = await state(formalRoot, 50);
    await expect(page.locator('#libraryRoot')).toContainText(formalRoot);
    for (const original of originalIndex.items) {
      const fetched = await bridge('libraryGet', original.id);
      expect(fetched.ok).toBe(true);
      expect(fetched.data.item.prompts).toEqual(original.prompts);
      expect(fetched.data.item.sourceMetadata).toEqual(original.sourceMetadata);
      expect(fetched.data.item.sourceImport).toEqual(original.sourceImport);
      expect(current.items.find(item => item.id === original.id).prompts).toEqual(original.prompts);
    }
    defaultSnapshots = { initial: { root: current.root, revision: current.revision, ids: current.items.map(item => item.id) } };
    const nativeSizes = await screenshotsOfAll();
    checks.push('default isolated profile without a library environment override reads all 50 external items; exact archive metadata, both full prompts, hashes, native decoding, protocol images and four same-size screenshots verified');
    for (const id of [1, 25, 50]) {
      const item = originalIndex.items.find(row => row.id === id);
      for (const language of ['en', 'zh']) {
        await galleryLanguage().getByRole('button', { name: languageName(language), exact: true }).click();
        const expected = item.prompts[language];
        await copy(() => card(id).locator('.copy-button').click(), expected, `${id} ${language} card button`);
        await expect(page.locator('#detailDialog')).not.toBeVisible();
        await card(id).focus();
        await copy(() => card(id).press('c'), expected, `${id} ${language} card keyboard`);
        await card(id).click();
        await expect(page.locator('#detailDialog')).toBeVisible();
        expect(await page.locator('#detailPrompt').textContent()).toBe(expected);
        await copy(() => page.locator('#detailCopy').click(), expected, `${id} ${language} detail button`);
        await copy(() => page.keyboard.press('Meta+Enter'), expected, `${id} ${language} detail keyboard`);
        await page.keyboard.press('Escape');
      }
    }
    expect((await bridge('libraryGet', '../escape')).ok).toBe(false);
    expect(await bridge('openImage', '/etc/passwd')).toBe(false);
    checks.push('IDs 1, 25 and 50 retain their exact English/Chinese prompt bytes across all four native clipboard entry points; invalid IPC IDs and paths rejected');
    await closeOwnedApp(); assertFormalUnchanged();
    await launch(defaultProfile);
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    current = await state(formalRoot, 50);
    expect(current.revision).toBe(originalIndex.revision);
    await expect(galleryLanguage().getByRole('button', { name: '中文', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await selectDialog(formalRoot, () => page.locator('#libraryConfigure').click());
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    expect(JSON.parse(fs.readFileSync(path.join(defaultProfile, 'library-config.json'), 'utf8')).root).toBe(formalRoot);
    await closeOwnedApp(); assertFormalUnchanged();
    await launch(defaultProfile);
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    current = await state(formalRoot, 50);
    defaultSnapshots.remembered = { root: current.root, revision: current.revision, ids: current.items.map(item => item.id) };
    expect(defaultSnapshots.remembered).toEqual(defaultSnapshots.initial);
    await closeOwnedApp(); assertFormalUnchanged();
    checks.push('full process restarts retain both default and explicitly remembered external roots, all 50 entries and Chinese language preference without altering any real library file');

    fs.cpSync(formalRoot, copyRoot, { recursive: true, dereference: false, errorOnExist: true });
    expect(treeHashes(copyRoot)).toEqual(formalBefore);
    const importedImage = path.join(temporary, 'isolated-import.png');
    fs.copyFileSync(storedImage(copyRoot, 1).file, importedImage);
    const importedHash = sha(fs.readFileSync(importedImage));
    await launch(copyProfile, { libraryRoot: copyRoot, writableRoot: copyRoot });
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    await selectDialog(copyRoot, () => page.locator('#libraryConfigure').click());
    current = await state(copyRoot, 50);
    newId = Math.max(...current.items.map(item => item.id)) + 1;
    expect(newId).toBeLessThanOrEqual(999999);
    const created = { id: newId, label: '外部图库隔离新增验证', type: 'photo', prompts: { en: 'Isolated external-library create verification: preserve this entire English prompt, including age 28, an 85 mm lens, and no letters or watermark.', zh: '外部图库隔离新增验证：完整保留这段中文提示词，包含 28 岁、85 毫米镜头，不要文字或水印。' } };
    await page.locator('#libraryCreate').click();
    await fillEditor(created);
    await selectDialog(importedImage, () => page.locator('#portraitChooseImage').click());
    await expect(page.locator('#portraitId')).toHaveValue(String(newId));
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    await expect(page.locator('.portrait-card')).toHaveCount(51);
    const createdStored = storedImage(copyRoot, newId);
    expect(createdStored.sha256).toBe(importedHash); expect(createdStored.item.prompts).toEqual(created.prompts);
    const beforeEdit = clone(storedImage(copyRoot, 25).item);
    const edited = { label: `${beforeEdit.label} · 隔离编辑验证`, type: beforeEdit.type === 'photo' ? 'art' : 'photo', prompts: { en: `${beforeEdit.prompts.en}\n\nIsolated edit verification: keep all preceding text intact.`, zh: `${beforeEdit.prompts.zh}\n\n隔离编辑验证：完整保留以上所有内容。` } };
    await card(25).click();
    await expect(page.locator('#detailDialog')).toBeVisible();
    await page.locator('#detailEdit').click(); await fillEditor(edited);
    await page.locator('#portraitSave').click(); await expect(page.locator('#portraitEditor')).not.toBeVisible();
    const afterEdit = storedImage(copyRoot, 25).item;
    expect(afterEdit.prompts).toEqual(edited.prompts); expect(afterEdit.label).toBe(edited.label); expect(afterEdit.type).toBe(edited.type);
    expect(afterEdit.sourceMetadata).toEqual(beforeEdit.sourceMetadata); expect(afterEdit.sourceImport).toEqual(beforeEdit.sourceImport);
    expect(afterEdit.sha256).toBe(beforeEdit.sha256);
    const detailLanguage = page.locator('#detailDialog').getByRole('group', { name: '提示词语言' });
    for (const language of ['en', 'zh']) {
      await detailLanguage.getByRole('button', { name: languageName(language), exact: true }).click();
      expect(await page.locator('#detailPrompt').textContent()).toBe(edited.prompts[language]);
      await copy(() => page.locator('#detailCopy').click(), edited.prompts[language], `edited 25 ${language} full prompt`);
    }
    await page.keyboard.press('Escape');
    await card(newId).click(); await expect(page.locator('#detailDialog')).toBeVisible();
    await page.locator('#detailDelete').click();
    await expect(page.locator('#deleteConfirmDialog')).toBeVisible();
    await page.locator('#deleteCancel').click();
    expect(fs.existsSync(createdStored.file)).toBe(true); expect(readIndex(copyRoot).items.length).toBe(51);
    await page.locator('#detailDelete').click(); await page.locator('#deleteConfirm').click();
    await expect(page.locator('#deleteConfirmDialog')).not.toBeVisible();
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    expect(fs.existsSync(createdStored.file)).toBe(false);
    const trashCalls = await app.evaluate(() => globalThis.__portraitExternalTrash);
    expect(trashCalls).toEqual([{ file: createdStored.file, success: true }]);
    const recoveryRoot = path.join(copyRoot, '.portrait-studio', 'recovery');
    const recovered = fs.readdirSync(recoveryRoot).map(name => {
      const directory = path.join(recoveryRoot, name);
      return { directory, record: JSON.parse(fs.readFileSync(path.join(directory, 'record.json'), 'utf8')), names: fs.readdirSync(directory) };
    }).find(entry => JSON.stringify(entry.record).includes(created.label));
    expect(recovered).toBeTruthy();
    expect(JSON.stringify(recovered.record)).toContain(created.prompts.en); expect(JSON.stringify(recovered.record)).toContain(created.prompts.zh);
    const recoveryImage = recovered.names.find(name => /^image\./.test(name));
    expect(recoveryImage).toBeTruthy(); expect(sha(fs.readFileSync(path.join(recovered.directory, recoveryImage)))).toBe(importedHash);
    const copiedIndex = readIndex(copyRoot);
    await closeOwnedApp(); assertFormalUnchanged();
    await launch(copyProfile, { writableRoot: copyRoot });
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    current = await state(copyRoot, 50); expect(current.revision).toBe(copiedIndex.revision);
    const rememberedEdit = (await bridge('libraryGet', 25)).data.item;
    expect(rememberedEdit.prompts).toEqual(edited.prompts); expect(rememberedEdit.sourceMetadata).toEqual(beforeEdit.sourceMetadata); expect(rememberedEdit.sourceImport).toEqual(beforeEdit.sourceImport);
    expect((await bridge('libraryGet', newId)).ok).toBe(false);
    await closeOwnedApp(); assertFormalUnchanged();
    checks.push('full temporary copy performs real UI create, metadata/bilingual edit, delete cancellation and confirmed system Trash; recovery contains complete prompts and image; provenance survives edit and process restart; real 50-item repository remains byte-identical');

    fs.writeFileSync(path.join(missingProfile, 'library-config.json'), json({ version: 1, root: missingRoot }));
    await launch(missingProfile);
    await expect(page.locator('#libraryNotice')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#libraryNotice')).not.toHaveText('');
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    await expect(page.locator('.portrait-image')).toHaveCount(0);
    await expect(page.locator('#emptyState')).toBeVisible();
    await expect(page.locator('#emptyState')).toContainText('请选择素材保存文件夹');
    await expect(page.locator('#libraryConfigure')).toBeEnabled();
    await expect(page.locator('#libraryBatch')).toBeDisabled();
    expect((await bridge('libraryList')).ok).toBe(false);
    await selectDialog(emptyRoot, () => page.locator('#libraryConfigure').click());
    await expect(page.locator('#libraryNotice')).toHaveCount(0);
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    await state(emptyRoot, 0);
    await expect(page.locator('#libraryBatch')).toBeEnabled();
    await page.locator('#libraryBatch').click(); await expect(page.locator('#batchImportDialog')).toBeVisible();
    await expect(page.locator('#batchChooseImages')).toBeEnabled(); await expect(page.locator('#batchChooseManifest')).toBeEnabled();
    await page.locator('#batchCancel').click(); await expect(page.locator('#batchImportDialog')).not.toBeVisible();
    const filename = `${kind}-missing-reconnected-empty-1440x920.png`;
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
    screenshots.push({ filename, width: 1440, height: 920, empty: true });
    await closeOwnedApp();
    await launch(missingProfile);
    await expect(page.locator('.portrait-card')).toHaveCount(0); await state(emptyRoot, 0);
    await expect(page.locator('#libraryBatch')).toBeEnabled();
    await closeOwnedApp(); assertFormalUnchanged();
    checks.push('missing remembered directory clearly reports an error and zero cards without bundled fallback; native choice of an empty writable folder enables batch import and persists through restart');
    expect(errors).toEqual([]);
    const report = { status: 'passed', version, kind, executable: executable || require('electron'), scope: 'real default library read-only; every mutation and Trash call confined to a full temporary copy', temporary, formalRoot, copyRoot, profiles: { defaultProfile, copyProfile, missingProfile }, unchangedFormalFiles: Object.keys(formalBefore).length, formalBefore, defaultSnapshots, itemChecks, nativeSizes, imageDecoding, security, clipboardChecks, screenshots, checks, errors };
    fs.writeFileSync(path.join(output, `${kind}-verification.json`), json(report));
    console.log(json({ status: report.status, version, kind, report: path.join(output, `${kind}-verification.json`), checkedItems: itemChecks.length, clipboardChecks: clipboardChecks.length, screenshots, checks, errors }));
  } catch (error) {
    fs.writeFileSync(path.join(output, `${kind}-verification.json`), json({ status: 'failed', version, kind, temporary, formalRoot, copyRoot, security, itemChecks, imageDecoding, clipboardChecks, screenshots, checks, errors, error: error.stack }));
    throw error;
  } finally { await closeOwnedApp(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
