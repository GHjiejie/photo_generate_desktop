'use strict';

// Production Electron renderer, preload, local IPC and recovery transactions.
// Only an owned temporary library/profile are used; Trash is redirected to an
// owned temporary folder. No real library, profile, clipboard or OS Trash changes.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PNG } = require('pngjs');
const { LocalLibrary } = require('../local-library.cjs');
const messages = require('../src/ui-messages.json');
const project = path.resolve(__dirname, '..');
const output = path.join(project, '.verification');
const report = { status: 'running', scope: 'Production Electron UI and local batch delete IPC with a temporary library/profile and redirected test Trash.', checks: [], errors: [] };
let app, temporary;

(async () => {
  try {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-batch-delete-ui-')));
    const root = path.join(temporary, 'library'), profile = path.join(temporary, 'profile'), trash = path.join(temporary, 'trash');
    await Promise.all([root, profile, trash, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const service = new LocalLibrary();
    let initial = await service.open(root);
    for (const [id, label] of [[1, 'Alpha one'], [2, 'Alpha two'], [3, 'Beta three'], [4, 'Beta four'], [5, 'Gamma five']]) {
      const png = new PNG({ width: 240, height: 320 });
      for (let i = 0; i < png.data.length; i += 4) png.data.set([60 + id * 20, 70 + Math.floor(i / 960) / 3, 155 + id * 10, 255], i);
      const source = path.join(temporary, `source-${id}.png`); await fs.writeFile(source, PNG.sync.write(png));
      initial = await service.create({ id, label, type: 'photo', prompts: { en: `Complete English fixture ${id}`, zh: `完整中文测试提示词 ${id}` }, expectedVersion: initial.revision }, source);
    }
    const sourceBytes = await Promise.all(initial.items.map(item => fs.readFile(path.join(temporary, `source-${item.id}.png`))));
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: root, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: require('electron'), args: [project], env });
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
    page.on('pageerror', error => report.errors.push(error.message));
    await app.evaluate(({ shell }, { root, trash }) => {
      const fs = process.getBuiltinModule('fs').promises, path = process.getBuiltinModule('path');
      globalThis.__deleteCalls = []; globalThis.__failDeleteId = null; globalThis.__holdDelete = false;
      shell.trashItem = async filename => {
        if (!filename.startsWith(path.join(root, 'assets/images') + path.sep)) throw new Error('Unowned test file');
        const id = Number(path.basename(filename).split('-')[0]); globalThis.__deleteCalls.push(id);
        if (globalThis.__holdDelete) await new Promise(resolve => { globalThis.__releaseDelete = resolve; });
        if (globalThis.__failDeleteId === id) throw Object.assign(new Error('Injected permission failure'), { code: 'EACCES' });
        await fs.rename(filename, path.join(trash, path.basename(filename)));
      };
    }, { root, trash });
    await expect(page.locator('.portrait-card')).toHaveCount(5);
    await page.evaluate(() => { localStorage.setItem('portraitStudio.uiLanguage', 'zh'); localStorage.setItem('portraitStudio.theme', 'dark'); });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(5);
    await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryDeleteBatch').click();
    await expect(page.locator('.select-checkbox')).toHaveCount(5);
    await page.locator('.portrait-card[data-id="1"]').click();
    await expect(page.locator('#detailDialog')).toBeHidden();
    await page.locator('#searchInput').fill('Beta'); await page.locator('#selectVisible').click();
    await expect(page.locator('#selectedCount')).toHaveText('已选 3 张 · 其中 1 张不在当前结果中');
    await page.locator('#selectVisible').click(); await expect(page.locator('#selectedCount')).toContainText('已选 1 张');
    await page.locator('#selectVisible').click();
    await page.locator('#batchDeleteSelected').click(); await expect(page.locator('.delete-object')).toHaveText('3 张图片');
    await expect(page.locator('.delete-description')).toContainText('macOS');
    await page.locator('#deleteCancel').click();
    expect(await app.evaluate(() => globalThis.__deleteCalls)).toEqual([]);
    await expect(page.locator('#selectedCount')).toContainText('已选 3 张');
    await page.locator('#clearSelection').click(); await expect(page.locator('#batchDeleteSelected')).toBeDisabled();
    await page.locator('#searchInput').fill('');
    await page.locator('.portrait-card[data-id="1"]').focus(); await page.keyboard.press('Space');
    await expect(page.locator('.portrait-card[data-id="1"] .select-checkbox')).toBeChecked();
    await page.keyboard.press('Escape'); await expect(page.locator('.select-checkbox')).toHaveCount(0);
    report.checks.push('Menu entry, card and keyboard selection, filtered select/deselect, hidden count, clear, Escape, and cancellation preserve the library');

    await page.locator('#beginBatchDelete').click();
    await page.locator('.portrait-card[data-id="1"] .select-checkbox').check();
    await page.locator('.portrait-card[data-id="2"] .select-checkbox').check();
    await page.locator('#batchDeleteSelected').click();
    const writer = new LocalLibrary(), current = await writer.open(root), edited = current.items.find(item => item.id === 2);
    await writer.update({ id: edited.id, label: 'Alpha two updated', type: edited.type, prompts: edited.prompts, expectedVersion: current.revision, expectedRevision: edited.revision });
    await page.locator('#deleteConfirm').click();
    await expect(page.locator('#deleteError')).toHaveText(messages.zh['app.batchDeleteConflict']);
    await expect(page.locator('#deleteConfirm')).toBeDisabled();
    expect(await app.evaluate(() => globalThis.__deleteCalls)).toEqual([]);
    await page.locator('#deleteCancel').click();
    await expect(page.locator('.portrait-card')).toHaveCount(5);
    await page.locator('#batchDeleteSelected').click();
    await page.screenshot({ path: path.join(output, 'batch-delete-confirmation-zh.png') });
    report.checks.push('A concurrent writer invalidates the whole batch before Trash; latest snapshot refreshes and requires a new confirmation');

    await app.evaluate(() => { globalThis.__holdDelete = true; });
    await page.locator('#deleteConfirm').click();
    await expect.poll(() => app.evaluate(() => typeof globalThis.__releaseDelete)).toBe('function');
    await expect(page.locator('#deleteConfirm')).toBeDisabled(); await expect(page.locator('#deleteCancel')).toBeDisabled();
    await expect(page.locator('#selectVisible')).toBeDisabled();
    await page.evaluate(() => { document.querySelector('#deleteConfirm').click(); });
    await app.evaluate(() => { globalThis.__holdDelete = false; globalThis.__releaseDelete(); });
    await expect(page.locator('#deleteConfirmDialog')).toBeHidden();
    await expect(page.locator('.portrait-card')).toHaveCount(3);
    expect(await app.evaluate(() => globalThis.__deleteCalls)).toEqual([1, 2]);
    await expect(page.locator('.select-checkbox')).toHaveCount(0);
    expect((await fs.readdir(trash)).length).toBe(2);
    report.checks.push('Confirmed desktop batch uses the real fixed IPC with current revisions, blocks duplicate actions while pending, and removes only selected images');

    await page.locator('#beginBatchDelete').click(); await page.locator('#selectVisible').click();
    await app.evaluate(() => { globalThis.__failDeleteId = 4; });
    await page.locator('#batchDeleteSelected').click(); await page.locator('#deleteConfirm').click();
    await expect(page.locator('#deleteConfirmDialog')).toBeHidden();
    await expect(page.locator('.portrait-card')).toHaveCount(2);
    await expect(page.locator('#selectedCount')).toHaveText('已选 2 张');
    await expect(page.locator('.portrait-card[data-id="4"] .select-checkbox')).toBeChecked();
    await expect(page.locator('.portrait-card[data-id="5"] .select-checkbox')).toBeChecked();
    await expect(page.locator('.toast')).toContainText('已移除 1 张，剩余 2 张仍保留选择');
    await expect(page.locator('.toast')).toHaveAttribute('role', 'alert');
    expect(await app.evaluate(() => globalThis.__deleteCalls)).toEqual([1, 2, 3, 4]);
    await page.screenshot({ path: path.join(output, 'batch-delete-partial-zh.png') });
    report.checks.push('Injected Trash failure stops the batch, restores the failed image, reports partial completion, and keeps failed/unattempted images selected');

    await page.locator('#settingsToggle').click(); await page.locator('#uiLanguage button[data-language="en"]').click();
    await page.locator('#themeControl button[data-theme="light"]').click(); await page.locator('#settingsPanel').press('Escape');
    await expect(page.locator('#selectedCount')).toHaveText('Selected 2');
    await page.screenshot({ path: path.join(output, 'batch-delete-selection-en-light.png') });
    await page.locator('#batchDeleteSelected').click();
    await expect(page.locator('.delete-description')).toHaveText(messages.en['delete.batchDescription']);
    await app.evaluate(() => { globalThis.__failDeleteId = null; });
    await page.locator('#deleteConfirm').click(); await expect(page.locator('.portrait-card')).toHaveCount(0);
    await expect(page.locator('#deleteConfirmDialog')).toBeHidden(); await expect(page.locator('#emptyState')).toBeVisible();
    await expect(page.locator('#emptyTitle')).toHaveText(messages.en['gallery.emptyTitle']);
    expect(await app.evaluate(() => globalThis.__deleteCalls)).toEqual([1, 2, 3, 4, 4, 5]);
    report.checks.push('Language/theme switch preserves selection, English confirmation is accurate, and retry deletes only the remaining IDs');

    await app.close(); app = null;
    const reopened = await new LocalLibrary().open(root); expect(reopened.items).toEqual([]);
    const recovery = path.join(root, '.portrait-studio/recovery'), deleted = [];
    for (const name of await fs.readdir(recovery)) {
      const record = JSON.parse(await fs.readFile(path.join(recovery, name, 'record.json'), 'utf8'));
      if (record.operation !== 'remove' || record.status !== 'deleted') continue;
      deleted.push(record.item.id);
      const files = await fs.readdir(path.join(recovery, name));
      const backup = await fs.readFile(path.join(recovery, name, files.find(file => /^image\./.test(file))));
      expect(backup).toEqual(sourceBytes[record.item.id - 1]);
      expect(record.item.prompts).toEqual(initial.items.find(item => item.id === record.item.id).prompts);
    }
    expect(deleted.sort()).toEqual([1, 2, 3, 4, 5]);
    for (let id = 1; id <= 5; id++) expect(await fs.readFile(path.join(temporary, `source-${id}.png`))).toEqual(sourceBytes[id - 1]);
    expect(await fs.readdir(path.join(root, '.portrait-studio/transactions'))).toEqual([]);
    expect(report.errors).toEqual([]);
    report.checks.push('Reopening retains deletions and complete prompt/image recovery copies; source bytes are unchanged and no pending journals remain');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'batch-delete-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, report: path.join(output, 'batch-delete-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
