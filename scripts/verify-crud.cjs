// Run against a source build, or set PORTRAIT_STUDIO_EXECUTABLE to a packaged
// executable. Every mutation targets a newly created temporary repository.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const originals = require('../assets/selected-prompts.json');
const translations = require('../assets/prompts.zh.json');
const version = require('../package.json').version;
const project = path.resolve(__dirname, '..');
const executable = process.env.PORTRAIT_STUDIO_EXECUTABLE;
const kind = process.env.PORTRAIT_STUDIO_VERIFICATION_NAME || `crud-${executable ? 'packaged' : 'source'}-${version}`;
if (!/^[a-zA-Z0-9._-]+$/.test(kind)) throw new Error('Verification name must be a plain filename component');
const output = path.join(project, '.verification');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `portrait-${kind}-`));
const libraryRoot = path.join(temporary, 'repository');
const profile = path.join(temporary, 'profile');
const indexPath = path.join(libraryRoot, '.portrait-studio', 'library.json');
const checks = [];
const clipboardChecks = [];
const screenshots = [];
const security = [];
const errors = [];
const originalHashes = {};
let app;
let page;
let clipboardSaved = false;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readIndex = () => JSON.parse(fs.readFileSync(indexPath, 'utf8'));

fs.mkdirSync(path.join(libraryRoot, 'assets', 'images'), { recursive: true });
fs.mkdirSync(profile);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(libraryRoot, 'assets', 'selected-prompts.json'), JSON.stringify(originals, null, 2));
fs.writeFileSync(path.join(libraryRoot, 'assets', 'prompts.zh.json'), JSON.stringify(translations, null, 2));
for (const item of originals) {
  const bytes = fs.readFileSync(path.join(project, 'assets', 'images', item.image));
  originalHashes[item.image] = sha(bytes);
  fs.writeFileSync(path.join(libraryRoot, 'assets', 'images', item.image), bytes);
}
const importedImage = path.join(temporary, 'imported-portrait.png');
const replacementImage = path.join(temporary, 'replacement-portrait.png');
fs.copyFileSync(path.join(libraryRoot, 'assets', 'images', originals[0].image), importedImage);
fs.copyFileSync(path.join(libraryRoot, 'assets', 'images', originals[1].image), replacementImage);
const importedHash = sha(fs.readFileSync(importedImage));
const replacementHash = sha(fs.readFileSync(replacementImage));

function storedImage(id) {
  const item = readIndex().items.find(value => value.id === id);
  expect(item, `index contains portrait ${id}`).toBeTruthy();
  const file = fs.realpathSync(path.join(libraryRoot, item.imageRel));
  const relative = path.relative(fs.realpathSync(libraryRoot), file);
  expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
  expect(file.includes('app.asar')).toBe(false);
  const bytes = fs.readFileSync(file);
  expect(item.size).toBe(bytes.length);
  expect(item.sha256).toBe(sha(bytes));
  return { item, file, hash: sha(bytes) };
}

function assertOriginalsUnchanged() {
  for (const item of originals) {
    expect(sha(fs.readFileSync(path.join(project, 'assets', 'images', item.image)))).toBe(originalHashes[item.image]);
    expect(sha(fs.readFileSync(path.join(libraryRoot, 'assets', 'images', item.image)))).toBe(originalHashes[item.image]);
  }
}

async function bridge(method, payload) {
  return page.evaluate(({ method, payload }) => window.portraitStudio[method](payload), { method, payload });
}

async function state() {
  const result = await bridge('libraryList');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.data.configured).toBe(true);
  expect(result.data.root).toBe(fs.realpathSync(libraryRoot));
  expect(result.data.writable).toBe(true);
  return result.data;
}

async function selectDialog(file, action) {
  await app.evaluate((_electron, result) => { globalThis.__portraitDialogQueue.push(result); }, file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] });
  await action();
  await expect.poll(() => app.evaluate(() => globalThis.__portraitDialogQueue.length)).toBe(0);
}

async function screenshot(name, viewport) {
  if (viewport) await page.setViewportSize(viewport);
  if (/^\d+x\d+-(normal|dense)$/.test(name)) {
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator('.brand-lockup').hover();
    await expect(page.locator('.portrait-card:hover')).toHaveCount(0);
  } else await page.mouse.move(0, 0);
  const filename = `${kind}-${name}.png`;
  await page.screenshot({ path: path.join(output, filename), scale: 'css', animations: 'disabled' });
  screenshots.push({ filename, viewport: page.viewportSize() });
}

async function copy(action, text, label) {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), `Portrait CRUD clipboard sentinel ${clipboardChecks.length}`);
  await action();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { message: label }).toBe(text);
  clipboardChecks.push(label);
}

async function fillEditor(value) {
  await expect(page.locator('#portraitEditor')).toBeVisible();
  if (value.id !== undefined) {
    await page.locator('#portraitId').fill(String(value.id));
    await expect(page.locator('#portraitId')).toHaveValue(String(value.id));
  }
  if (value.label !== undefined) await page.locator('#portraitLabel').fill(value.label);
  if (value.type !== undefined) await page.locator('#portraitType').selectOption(value.type);
  if (value.prompts) {
    await page.locator('#portraitPromptEn').fill(value.prompts.en);
    await page.locator('#portraitPromptZh').fill(value.prompts.zh);
  }
  if (value.id !== undefined) await expect(page.locator('#portraitId')).toHaveValue(String(value.id));
}

async function closeOwnedApp() {
  if (!app) return;
  if (clipboardSaved) {
    await app.evaluate(({ clipboard }) => clipboard.write(globalThis.__portraitCrudClipboard)).catch(() => {});
    clipboardSaved = false;
  }
  await app.close();
  app = undefined;
}

async function launch(useEnvironment = true) {
  const environment = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
  delete environment.PORTRAIT_STUDIO_LIBRARY_DIR;
  if (useEnvironment) environment.PORTRAIT_STUDIO_LIBRARY_DIR = libraryRoot;
  app = await electron.launch({
    executablePath: executable || require('electron'),
    args: executable ? [] : [project],
    env: environment,
  });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await app.evaluate(({ clipboard, dialog, shell }) => {
    globalThis.__portraitCrudClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
    globalThis.__portraitDialogQueue = [];
    globalThis.__portraitDialogs = [];
    // Only native picking is controlled. File validation, installation, IPC and
    // system Trash calls still execute the production implementation.
    dialog.showOpenDialog = async (...args) => {
      globalThis.__portraitDialogs.push(args[args.length - 1]);
      if (!globalThis.__portraitDialogQueue.length) throw new Error('Unexpected native file picker in isolated CRUD verification');
      return globalThis.__portraitDialogQueue.shift();
    };
    const originalTrash = shell.trashItem;
    globalThis.__portraitTrash = [];
    shell.trashItem = async file => {
      await originalTrash(file);
      globalThis.__portraitTrash.push({ file, success: true });
    };
  });
  clipboardSaved = true;
  const settings = await app.evaluate(({ BrowserWindow, app }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { pid: process.pid, packaged: app.isPackaged, userData: app.getPath('userData'), contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, sandbox: preferences.sandbox, webSecurity: preferences.webSecurity };
  });
  expect(settings.userData).toBe(profile);
  expect(settings.contextIsolation).toBe(true);
  expect(settings.nodeIntegration).toBe(false);
  expect(settings.sandbox).toBe(true);
  expect(settings.webSecurity).toBe(true);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  security.push(settings);
  await expect(page.locator('.portrait-card')).toHaveCount(13);
}

(async () => {
  try {
    await launch();
    let current = await state();
    expect(current.items.length).toBe(13);
    await expect(page.locator('#libraryRoot')).toContainText(libraryRoot);
    await expect(page.locator('#libraryCreate')).toBeEnabled();
    for (const item of originals) {
      const fetched = await bridge('libraryGet', item.id);
      expect(fetched.ok).toBe(true);
      expect(fetched.data.item.prompts).toEqual({ en: item.prompt, zh: translations[String(item.id)] });
      expect(storedImage(item.id).hash).toBe(originalHashes[item.image]);
    }
    assertOriginalsUnchanged();
    checks.push('isolated writable repository initialized with all 13 exact bilingual prompts and original image hashes');

    for (const [width, height] of [[1440, 920], [2048, 1280]]) {
      await page.setViewportSize({ width, height });
      await page.locator('.portrait-image').evaluateAll(async images => {
        for (const image of images) { image.loading = 'eager'; await image.decode(); }
      });
      for (const dense of [false, true]) {
        if ((await page.locator('#gallery').getAttribute('class')).includes('dense') !== dense) await page.locator('#gridToggle').click();
        await screenshot(`${width}x${height}-${dense ? 'dense' : 'normal'}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 920 });
    if ((await page.locator('#gallery').getAttribute('class')).includes('dense')) await page.locator('#gridToggle').click();
    checks.push('original gallery images decoded and same-size normal/dense screenshots recorded');

    const unchangedIndex = fs.readFileSync(indexPath);
    await selectDialog(null, () => page.locator('#libraryConfigure').click());
    expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    expect((await state()).revision).toBe(current.revision);
    const alternateRoot = path.join(temporary, 'alternate-repository');
    fs.mkdirSync(alternateRoot);
    await selectDialog(alternateRoot, () => page.locator('#libraryConfigure').click());
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    const alternate = await bridge('libraryList');
    expect(alternate.ok).toBe(true);
    expect(alternate.data.root).toBe(fs.realpathSync(alternateRoot));
    expect(alternate.data.items).toEqual([]);
    expect(fs.existsSync(path.join(alternateRoot, '.portrait-studio', 'library.json'))).toBe(true);
    await selectDialog(libraryRoot, () => page.locator('#libraryConfigure').click());
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    await page.locator('.portrait-image').evaluateAll(async images => {
      for (const image of images) { image.loading = 'eager'; await image.decode(); }
    });
    expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    expect(JSON.parse(fs.readFileSync(path.join(profile, 'library-config.json'), 'utf8')).root).toBe(fs.realpathSync(libraryRoot));
    const unwritableRoot = path.join(temporary, 'read-only-repository');
    fs.mkdirSync(unwritableRoot);
    fs.chmodSync(unwritableRoot, 0o555);
    try {
      await selectDialog(unwritableRoot, () => page.locator('#libraryConfigure').click());
      await expect(page.locator('#libraryNotice')).toHaveAttribute('role', 'alert');
      await expect(page.locator('#libraryNotice')).toContainText(/权限/);
      expect((await state()).root).toBe(fs.realpathSync(libraryRoot));
      expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    } finally { fs.chmodSync(unwritableRoot, 0o700); }
    await page.locator('#libraryRefresh').click();
    await expect(page.locator('#libraryNotice')).toHaveCount(0);
    checks.push('native directory choice switches to a real empty writable repository and back; saved configuration persists; permission failure preserves the prior repository');
    await page.locator('#libraryCreate').click();
    await expect(page.locator('#portraitEditor')).toBeVisible();
    await fillEditor({ id: 201, label: '取消的本地素材', prompts: { en: 'Cancelled English', zh: '取消的中文' } });
    await selectDialog(null, () => page.locator('#portraitChooseImage').click());
    expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    await selectDialog(importedImage, () => page.locator('#portraitChooseImage').click());
    await expect(page.locator('#portraitImagePreview')).toBeVisible();
    await screenshot('create-editor-1440x920');
    await page.locator('#portraitCancel').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    expect((await state()).items.length).toBe(13);
    checks.push('native directory/image cancellation and cancelling populated import make no repository changes');

    const newPortrait = { id: 201, label: '本地闭环测试', type: 'art', prompts: { en: 'Local CRUD test portrait, age 28, 85 mm lens, eye-level composition. No lettering or watermark.', zh: '本地闭环测试肖像，28 岁，85 毫米镜头，平视构图。不要文字或水印。' } };
    const forged = await bridge('createPortrait', { ...newPortrait, expectedVersion: current.revision, imageToken: '/etc/passwd' });
    expect(forged.ok).toBe(false);
    expect(forged.error.code).toBeTruthy();
    expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    await page.locator('#libraryCreate').click();
    await fillEditor(newPortrait);
    const malformed = path.join(temporary, 'invalid.png');
    fs.writeFileSync(malformed, 'not an image');
    await selectDialog(malformed, () => page.locator('#portraitChooseImage').click());
    await expect(page.locator('#portraitFormError')).toBeVisible();
    expect(fs.readFileSync(indexPath)).toEqual(unchangedIndex);
    await selectDialog(importedImage, () => page.locator('#portraitChooseImage').click());
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    await expect(page.locator('.portrait-card')).toHaveCount(14);
    current = await state();
    const createdAsset = storedImage(201);
    expect(createdAsset.hash).toBe(importedHash);
    expect(createdAsset.item.prompts).toEqual(newPortrait.prompts);
    expect(createdAsset.item.type).toBe('art');
    expect(createdAsset.item.label).toBe(newPortrait.label);
    checks.push('forged image token and malformed image rejected; UI create persists imported bytes and both complete prompts');

    await page.locator('#libraryCreate').click();
    await fillEditor(newPortrait);
    await selectDialog(importedImage, () => page.locator('#portraitChooseImage').click());
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitFormError')).toBeVisible();
    await expect(page.locator('#portraitEditor')).toBeVisible();
    expect((await state()).revision).toBe(current.revision);
    expect(readIndex().items.filter(item => item.id === 201).length).toBe(1);
    await page.locator('#portraitCancel').click();
    await page.locator('[data-filter="art"]').click();
    await expect(page.locator('.portrait-card')).toHaveCount(6);
    await page.locator('#searchInput').fill('本地闭环');
    await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('.portrait-card').click();
    await expect(page.locator('#detailTitle')).toHaveText(newPortrait.label);
    const detailLanguage = page.locator('#detailDialog').getByRole('group', { name: '提示词语言' });
    await detailLanguage.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.locator('#detailPrompt')).toHaveText(newPortrait.prompts.en);
    await copy(() => page.locator('#detailCopy').click(), newPortrait.prompts.en, 'created English native detail copy');
    await detailLanguage.getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.locator('#detailPrompt')).toHaveText(newPortrait.prompts.zh);
    await copy(() => page.keyboard.press('Meta+Enter'), newPortrait.prompts.zh, 'created Chinese native detail keyboard copy');
    checks.push('duplicate ID retains form without writes; created item participates in category/search/detail and both language clipboard actions');

    const beforeCancel = fs.readFileSync(indexPath);
    await page.locator('#detailEdit').click();
    await expect(page.locator('#portraitEditor')).toBeVisible();
    await fillEditor({ label: '取消的修改', type: 'photo', prompts: { en: 'Cancelled edit English', zh: '取消修改中文' } });
    await selectDialog(replacementImage, () => page.locator('#portraitChooseImage').click());
    await page.locator('#portraitCancel').click();
    expect(fs.readFileSync(indexPath)).toEqual(beforeCancel);
    expect(storedImage(201).hash).toBe(importedHash);
    checks.push('cancelling metadata, dual-prompt and replacement-image edits leaves persisted state unchanged');

    const editedPortrait = { label: '已编辑本地测试', type: 'photo', prompts: { en: 'Edited local portrait, age 31, 50 mm, centered composition; retain freckles. No text or watermark.', zh: '编辑后的本地肖像，31 岁、50 毫米、居中构图；保留雀斑。不要文字或水印。' } };
    await page.locator('#detailEdit').click();
    await fillEditor(editedPortrait);
    await selectDialog(replacementImage, () => page.locator('#portraitChooseImage').click());
    await screenshot('edit-editor-1440x920');
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    current = await state();
    const editedAsset = storedImage(201);
    expect(editedAsset.hash).toBe(replacementHash);
    expect(editedAsset.item.prompts).toEqual(editedPortrait.prompts);
    expect(editedAsset.item.type).toBe('photo');
    expect(editedAsset.item.label).toBe(editedPortrait.label);
    await page.keyboard.press('Escape');
    await page.locator('[data-filter="photo"]').click();
    await page.locator('#searchInput').fill('已编辑本地');
    await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('.portrait-card').click();
    await detailLanguage.getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.locator('#detailPrompt')).toHaveText(editedPortrait.prompts.zh);
    await copy(() => page.locator('#detailCopy').click(), editedPortrait.prompts.zh, 'edited Chinese native detail copy');
    await detailLanguage.getByRole('button', { name: 'English', exact: true }).click();
    await copy(() => page.keyboard.press('Meta+Enter'), editedPortrait.prompts.en, 'edited English native detail keyboard copy');
    await screenshot('edited-detail-1440x920');
    checks.push('edit persists label/category/complete bilingual prompts and replaced image bytes; filters and native copies use saved edits');

    await page.locator('#detailEdit').click();
    await page.locator('#portraitLabel').fill('冲突核对后保存');
    const winnerPrompts = { en: 'Concurrent writer English prompt.', zh: '并发写入者的中文提示词。' };
    const winner = await bridge('updatePortrait', { id: 201, label: editedPortrait.label, type: 'photo', prompts: winnerPrompts, expectedVersion: current.revision, expectedRevision: current.items.find(item => item.id === 201).revision });
    expect(winner.ok).toBe(true);
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitFormError')).toBeVisible();
    await expect(page.locator('#portraitReviewConflict')).toBeVisible();
    expect(storedImage(201).item.prompts).toEqual(winnerPrompts);
    await expect(page.locator('#portraitLabel')).toHaveValue('冲突核对后保存');
    await page.locator('#portraitReviewConflict').click();
    await expect(page.locator('#portraitAcknowledgeConflict')).toBeVisible();
    await page.locator('#portraitAcknowledgeConflict').click();
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).not.toBeVisible();
    current = await state();
    const finalAsset = storedImage(201);
    expect(finalAsset.item.label).toBe('冲突核对后保存');
    expect(finalAsset.item.prompts).toEqual(editedPortrait.prompts);
    expect(finalAsset.hash).toBe(replacementHash);
    checks.push('concurrent update is rejected without overwriting disk; pending form survives until explicit version review and save');

    await page.keyboard.press('Escape');
    await page.locator('#searchInput').fill('冲突核对后保存');
    await page.locator('.portrait-card').click();
    const deleteBefore = fs.readFileSync(indexPath);
    const trashBeforeDelete = await app.evaluate(() => globalThis.__portraitTrash.length);
    await page.locator('#detailDelete').click();
    await expect(page.locator('#deleteConfirmDialog')).toBeVisible();
    await screenshot('delete-confirm-1440x920');
    await page.locator('#deleteCancel').click();
    await expect(page.locator('#deleteConfirmDialog')).not.toBeVisible();
    expect(fs.readFileSync(indexPath)).toEqual(deleteBefore);
    expect(fs.existsSync(finalAsset.file)).toBe(true);
    expect(await app.evaluate(() => globalThis.__portraitTrash.length)).toBe(trashBeforeDelete);
    checks.push('delete confirmation cancel sends no Trash call and changes no files');

    const staleRemoval = { id: 201, expectedVersion: current.revision, expectedRevision: current.items.find(item => item.id === 201).revision, confirmed: true };
    await page.locator('#detailDelete').click();
    await page.locator('#deleteConfirm').click();
    await expect(page.locator('#deleteConfirmDialog')).not.toBeVisible();
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    expect(fs.existsSync(finalAsset.file)).toBe(false);
    const trashCalls = await app.evaluate(() => globalThis.__portraitTrash);
    expect(trashCalls.length).toBe(trashBeforeDelete + 1);
    expect(trashCalls.at(-1).file).toBe(finalAsset.file);
    expect(trashCalls.at(-1).success).toBe(true);
    const recoveryDirectory = path.join(libraryRoot, '.portrait-studio', 'recovery');
    const recovery = fs.readdirSync(recoveryDirectory).map(name => {
      const directory = path.join(recoveryDirectory, name);
      return { directory, names: fs.readdirSync(directory), record: JSON.parse(fs.readFileSync(path.join(directory, 'record.json'), 'utf8')) };
    });
    const recovered = recovery.find(entry => JSON.stringify(entry.record).includes(finalAsset.item.label));
    expect(recovered).toBeTruthy();
    expect(JSON.stringify(recovered.record)).toContain(editedPortrait.prompts.en);
    expect(JSON.stringify(recovered.record)).toContain(editedPortrait.prompts.zh);
    const recoveryImage = recovered.names.find(name => /^image\./.test(name));
    expect(recoveryImage).toBeTruthy();
    expect(sha(fs.readFileSync(path.join(recovered.directory, recoveryImage)))).toBe(replacementHash);
    const repeated = await bridge('deletePortrait', staleRemoval);
    expect(repeated.ok).toBe(false);
    expect(['NOT_FOUND', 'CONFLICT']).toContain(repeated.error.code);
    expect(await app.evaluate(() => globalThis.__portraitTrash.length)).toBe(trashBeforeDelete + 1);
    expect(readIndex().items.length).toBe(13);
    assertOriginalsUnchanged();
    checks.push('confirmed delete invokes real system Trash once, removes index entry and retains complete bilingual metadata plus image for recovery; repeat rejected');

    await page.locator('#searchInput').fill('');
    await page.locator('[data-filter="all"]').click();
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    const beforeRestart = readIndex();
    await page.locator('.toolbar').getByRole('group', { name: '提示词语言' }).getByRole('button', { name: '中文', exact: true }).click();
    await closeOwnedApp();
    await launch(false);
    current = await state();
    expect(current.revision).toBe(beforeRestart.revision);
    expect(current.items.map(item => item.id).sort((a, b) => a - b)).toEqual(originals.map(item => item.id).sort((a, b) => a - b));
    await expect(page.locator('.toolbar').getByRole('group', { name: '提示词语言' }).getByRole('button', { name: '中文', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.portrait-card').first().click();
    await expect(page.locator('#detailPrompt')).toHaveText(translations[String(originals[0].id)]);
    await copy(() => page.locator('#detailCopy').click(), translations[String(originals[0].id)], 'original Chinese copy after process restart');
    await page.keyboard.press('Escape');
    await page.locator('#libraryRefresh').click();
    await expect(page.locator('.portrait-card')).toHaveCount(13);
    assertOriginalsUnchanged();
    checks.push('full process restart preserves collection revision, deletion, all 13 originals and Chinese preference; refresh and original copy still work');

    for (const value of ['../main.js', '/etc/passwd', { id: '../escape', revision: 1 }, { id: 201, revision: 1 }]) {
      expect(await bridge('openImage', value)).toBe(false);
    }
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await page.evaluate(() => window.open('https://example.com'));
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows);
    checks.push('configured-library original-image IPC rejects traversal/forged/deleted IDs and renderer popup is denied');
    expect(errors).toEqual([]);
    const report = { status: 'passed', version, kind, executable: executable || require('electron'), temporary, libraryRoot, profile, indexPath, originalHashes, importedHash, replacementHash, security, clipboardChecks, screenshots, checks, errors };
    fs.writeFileSync(path.join(output, `${kind}-verification.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = { status: 'failed', version, kind, temporary, libraryRoot, profile, security, clipboardChecks, screenshots, checks, errors, error: error.stack };
    fs.writeFileSync(path.join(output, `${kind}-verification.json`), JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally {
    await closeOwnedApp();
    // Preserve this isolated repository and its recovery records for the report;
    // never remove system Trash files or close apps opened by the user.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
