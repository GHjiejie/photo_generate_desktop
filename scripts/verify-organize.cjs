'use strict';

// Production Electron/React/IPC with owned temporary libraries and profile.
// Clipboard output is captured in this test process; no OS clipboard is touched.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LocalLibrary } = require('../local-library.cjs');
const messages = require('../src/ui-messages.json');
const project = path.resolve(__dirname, '..'), output = path.join(project, '.verification');
const report = { status: 'running', checks: [], errors: [], scope: 'Actual Electron UI, preload and local IPC with two temporary libraries and an isolated profile; no real library, native picker, OS clipboard or system Trash changes.' };
let app, temporary;

async function fixture(root, entries) {
  const library = new LocalLibrary();
  let snapshot = await library.open(root);
  for (const [id, label, image] of entries) {
    const prompts = {
      en: `Subject: inspiration fixture ${id}.\nStyle: natural light, layered composition, complete details.\nConstraints: preserve every line of this English prompt, including fixture ID ${id}.`,
      zh: `主体：灵感测试图片 ${id}。\n风格：自然光、分层构图，保留完整细节。\n约束：保留中文提示词的每一行，包括测试编号 ${id}。`
    };
    snapshot = await library.create({ id, label, type: 'photo', prompts, expectedVersion: snapshot.revision }, path.join(project, 'assets/images', image));
  }
  return snapshot;
}
async function bytes(root, snapshot) {
  return Promise.all([fs.readFile(path.join(root, '.portrait-studio/library.json')), ...snapshot.items.map(item => fs.readFile(path.join(root, 'assets/images', item.image)))]);
}

(async () => {
  try {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-organize-ui-')));
    const rootA = path.join(temporary, 'library-a'), rootB = path.join(temporary, 'library-b');
    const profile = path.join(temporary, 'profile'), trash = path.join(temporary, 'trash');
    await Promise.all([rootA, rootB, profile, trash, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const initialA = await fixture(rootA, [[1, 'Alpha one', '001-natural-window.png'], [2, 'Alpha two', '003-korean-fresh.png'], [3, 'Beta three', '012-italian-luxury.png'], [4, 'Beta four', '013-scandinavian-minimal.png'], [5, 'Gamma five', '033-autumn-forest.png']]);
    const initialB = await fixture(rootB, [[1, 'Other one', '031-rainy-night.png'], [2, 'Other two', '043-renaissance.png']]);
    const beforeA = await bytes(rootA, initialA), beforeB = await bytes(rootB, initialB);
    const keyA = `portraitStudio.tags.v1.${JSON.stringify(['local', '', rootA])}`;
    const keyB = `portraitStudio.tags.v1.${JSON.stringify(['local', '', rootB])}`;
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: rootA, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const ids = page => page.locator('.portrait-card').evaluateAll(cards => cards.map(card => Number(card.dataset.id)));
    const compare = (page, id) => page.locator(`.portrait-card[data-id="${id}"] .compare-button`);
    const decode = page => page.evaluate(() => Promise.all([...document.querySelectorAll('.portrait-image')].map(image => image.decode())));
    async function launch() {
      app = await electron.launch({ executablePath: require('electron'), args: [project], env });
      const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
      page.on('pageerror', error => report.errors.push(error.message));
      await app.evaluate(({ clipboard }) => { globalThis.__organizeCopies = []; clipboard.writeText = text => globalThis.__organizeCopies.push(text); });
      await expect(page.locator('.portrait-card')).toHaveCount(5); await decode(page);
      return page;
    }
    async function openDetail(page, id) {
      await page.locator(`.portrait-card[data-id="${id}"]`).click();
      await expect(page.locator('#detailDialog')).toBeVisible();
      await expect(page.locator('#detailIndex')).toContainText(String(id).padStart(3, '0'));
    }
    async function addTags(page, id, value, count) {
      await openDetail(page, id); await page.locator('#tagInput').fill(value); await page.locator('#tagInput').press('Enter');
      await expect(page.locator('.tag-chip')).toHaveCount(count);
      await page.locator('#closeDialog').click();
    }
    async function switchLibrary(page, root, count) {
      await decode(page);
      await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
      await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryConfigure').click();
      await expect(page.locator('.portrait-card')).toHaveCount(count);
      await expect(page.locator('#compareTray')).toHaveCount(0);
    }
    async function externalWrite(page, action) {
      await decode(page);
      await expect.poll(async () => {
        try { await action(); return 'done'; }
        catch (error) { if (error.code !== 'LIBRARY_BUSY') throw error; return 'busy'; }
      }, { timeout: 10000, intervals: [100, 250, 500] }).toBe('done');
    }
    let page = await launch();
    await page.evaluate(() => { localStorage.setItem('portraitStudio.uiLanguage', 'zh'); localStorage.setItem('portraitStudio.theme', 'dark'); localStorage.setItem('portraitStudio.sidebarCollapsed', 'false'); });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(5);
    await openDetail(page, 1);
    await page.locator('#tagInput').fill('窗光，Film, film'); await page.locator('#tagInput').press('Enter');
    await expect(page.locator('.tag-chip')).toHaveCount(2);
    await page.locator('#tagInput').fill('x'.repeat(33)); await page.locator('#addTag').click();
    await expect(page.locator('#tagError')).toBeVisible(); await expect(page.locator('.tag-chip')).toHaveCount(2);
    await page.locator('#tagInput').press('ArrowRight'); await expect(page.locator('#detailIndex')).toContainText('001');
    await page.screenshot({ path: path.join(output, 'organize-tags-zh-dark.png') });
    await page.locator('#tagInput').fill(''); await page.locator('#closeDialog').click();
    await addTags(page, 2, 'film, 旅行', 2); await addTags(page, 3, '旅行，自然', 2);
    await page.locator('#searchInput').fill('FILM'); expect(await ids(page)).toEqual([1, 2]);
    await page.locator('#searchInput').fill(''); await page.locator('#tagFilter').selectOption('film');
    expect(await ids(page)).toEqual([1, 2]);
    await page.locator('.portrait-card[data-id="2"] .favorite-button').click(); await page.locator('#favoriteImages').click();
    expect(await ids(page)).toEqual([2]);
    await page.locator('#searchInput').fill('nonexistent'); await expect(page.locator('#emptyTitle')).toHaveText(messages.zh['tags.noResults']);
    await page.locator('#resetGalleryFilters').click(); expect(await ids(page)).toEqual([1, 2, 3, 4, 5]);
    await expect(page.locator('#tagFilter')).toHaveValue('');
    const storedA = await page.evaluate(key => localStorage.getItem(key), keyA);
    expect(JSON.parse(storedA)).toEqual({ 1: ['窗光', 'Film'], 2: ['film', '旅行'], 3: ['旅行', '自然'] });
    report.checks.push('Tags normalize and deduplicate, validate length, isolate text editing keys, and combine with search/favorites filters and empty-state recovery');

    await compare(page, 1).focus(); await page.keyboard.press('Space');
    await expect(page.locator('#detailDialog')).toBeHidden(); await expect(page.locator('#openComparison')).toBeDisabled();
    await page.locator('#searchInput').fill('Beta'); await compare(page, 3).click(); await compare(page, 4).click();
    await page.locator('#searchInput').fill(''); await compare(page, 2).click();
    await expect(page.locator('.compare-thumbnail')).toHaveCount(4);
    await compare(page, 5).click(); await expect(page.locator('#toastMessage')).toHaveText(messages.zh['compare.limit']);
    await expect(page.locator('.compare-thumbnail')).toHaveCount(4);
    await page.locator('.main-content').evaluate(main => { main.scrollTop = 0; });
    await page.screenshot({ path: path.join(output, 'organize-compare-candidates-zh-dark.png') });
    await page.locator('#openComparison').click(); await expect(page.locator('#compareDialog')).toBeVisible();
    await expect(page.locator('.compare-column')).toHaveCount(4);
    for (const id of [1, 3, 4, 2]) {
      const column = page.locator(`.compare-column[data-id="${id}"]`);
      await expect(column.locator('pre')).toHaveText(initialA.items.find(item => item.id === id).prompts.zh);
      await column.locator('.compare-copy').click();
      await expect.poll(() => app.evaluate(() => globalThis.__organizeCopies.at(-1))).toBe(initialA.items.find(item => item.id === id).prompts.zh);
      expect(await column.locator('img').evaluate(image => getComputedStyle(image).objectFit)).toBe('contain');
    }
    await page.screenshot({ path: path.join(output, 'organize-compare-four-zh-dark.png') });
    await page.keyboard.press('Escape'); await expect(page.locator('#compareDialog')).toBeHidden();
    await expect(page.locator('.compare-thumbnail')).toHaveCount(4);
    await page.locator('.compare-thumbnail').nth(1).click(); await expect(page.locator('.compare-thumbnail')).toHaveCount(3);
    await page.locator('#clearComparison').click(); await expect(page.locator('#compareTray')).toHaveCount(0);
    expect(await bytes(rootA, initialA)).toEqual(beforeA); expect(await bytes(rootB, initialB)).toEqual(beforeB);
    report.checks.push('Cross-search comparison selection, keyboard activation, 2–4 limit, full images/prompts, native copying, Escape, remove/clear all work without changing library bytes');

    await compare(page, 1).click(); await compare(page, 2).click();
    await page.locator('#beginBatchDelete').click(); await expect(page.locator('.gallery .compare-button')).toHaveCount(0);
    await expect(page.locator('#openComparison')).toBeDisabled(); await expect(page.locator('#compareToggle')).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(page.locator('#openComparison')).toBeEnabled();
    const writer = new LocalLibrary();
    let latest;
    await externalWrite(page, async () => {
      const snapshot = await writer.open(rootA), item = snapshot.items.find(item => item.id === 2);
      latest = await writer.update({ id: 2, label: item.label, type: item.type, prompts: { en: item.prompts.en + '\nNewest English line.', zh: item.prompts.zh + '\n最新中文内容。' }, expectedVersion: snapshot.revision, expectedRevision: item.revision });
    });
    await page.locator('#compareToggle').click(); await expect(page.locator('#compareDialog')).toBeVisible();
    await expect(page.locator('.compare-column[data-id="2"] pre')).toContainText('最新中文内容。');
    await page.locator('.compare-column[data-id="2"] .compare-copy').click();
    await expect.poll(() => app.evaluate(() => globalThis.__organizeCopies.at(-1))).toBe(latest.items.find(item => item.id === 2).prompts.zh);
    await page.locator('#closeComparison').click();
    await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryRefresh').click();
    await expect(page.locator('#compareTray')).toBeVisible();
    report.checks.push('Batch deletion mode suspends comparisons and restores selection on Escape; comparison reads and copies a concurrent writer’s latest prompt/revision');

    await switchLibrary(page, rootB, 2); await expect(page.locator('#tagFilter')).toHaveCount(0);
    await addTags(page, 1, '另一个图库', 1);
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyB)).toEqual({ 1: ['另一个图库'] });
    expect(await page.evaluate(key => localStorage.getItem(key), keyA)).toBe(storedA);
    await switchLibrary(page, rootA, 5); await expect(page.locator('#tagFilter')).toHaveValue('');
    await openDetail(page, 1); await expect(page.locator('.tag-chip')).toHaveCount(2); await page.locator('#closeDialog').click();
    await page.locator('#settingsToggle').click(); await page.locator('#uiLanguage button[data-language="en"]').click();
    await page.locator('#themeControl button[data-theme="light"]').click(); await page.locator('#settingsPanel').press('Escape');
    await compare(page, 1).click(); await compare(page, 2).click(); await page.locator('#openComparison').click();
    await expect(page.locator('#compareTitle')).toHaveText(messages.en['compare.title']);
    await expect(page.locator('.compare-column[data-id="2"] pre')).toContainText('Newest English line.');
    await page.locator('.compare-column[data-id="2"] .compare-copy').click();
    await expect.poll(() => app.evaluate(() => globalThis.__organizeCopies.at(-1))).toBe(latest.items.find(item => item.id === 2).prompts.en);
    await page.screenshot({ path: path.join(output, 'organize-compare-two-en-light.png') });
    await page.locator('#closeComparison').click(); await page.locator('#clearComparison').click();
    report.checks.push('Switching libraries isolates tags for overlapping IDs and clears comparisons; bilingual/light-dark layouts and full English copying work');

    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (key.startsWith('portraitStudio.tags.')) throw new DOMException('Test quota', 'QuotaExceededError'); return original.call(this, key, value); };
    });
    await addTags(page, 4, 'session-only', 1);
    await expect(page.locator('#toastMessage')).toHaveText(messages.en['tags.sessionOnly']);
    await expect(page.locator('#toast')).toHaveAttribute('role', 'alert');
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(5);
    await openDetail(page, 4); await expect(page.locator('.tag-chip')).toHaveCount(0); await page.locator('#closeDialog').click();
    await page.evaluate(key => localStorage.setItem(key, '{broken-json'), keyA); await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(5); await expect(page.locator('#tagFilter')).toHaveCount(0);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: keyA, value: storedA });
    await page.reload(); await expect(page.locator('#tagFilter')).toBeVisible();
    await app.close(); app = null; page = await launch();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#tagFilter option[value="film"]')).toHaveText('Film (2)');
    await openDetail(page, 1); await expect(page.locator('.tag-chip')).toHaveCount(2);
    await page.locator('.tag-chip').filter({ hasText: 'Film' }).click(); await expect(page.locator('.tag-chip')).toHaveCount(1);
    await page.locator('#tagInput').fill('Film'); await page.locator('#addTag').click(); await expect(page.locator('.tag-chip')).toHaveCount(2);
    await page.locator('.detail-image-actions .compare-button').click(); await page.locator('#closeDialog').click();
    await compare(page, 2).click(); await expect(page.locator('.compare-thumbnail')).toHaveCount(2);
    report.checks.push('Failed preference writes retain session edits and notify; damaged JSON recovers; tags persist across an actual restart and can be removed/re-added');

    const remover = new LocalLibrary({ trashItem: filename => {
      if (!filename.startsWith(path.join(rootA, 'assets/images') + path.sep)) throw new Error('Unowned test file');
      return fs.rename(filename, path.join(trash, path.basename(filename)));
    } });
    await externalWrite(page, async () => {
      const snapshot = await remover.open(rootA), item = snapshot.items.find(item => item.id === 1);
      await remover.remove({ id: 1, expectedVersion: snapshot.revision, expectedRevision: item.revision, confirmed: true });
    });
    await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryRefresh').click();
    await expect(page.locator('.portrait-card')).toHaveCount(4); await expect(page.locator('.compare-thumbnail')).toHaveCount(1);
    await expect(page.locator('#openComparison')).toBeDisabled();
    await expect.poll(() => page.evaluate(key => Object.keys(JSON.parse(localStorage.getItem(key))).sort(), keyA)).toEqual(['2', '3']);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyB)).toEqual({ 1: ['另一个图库'] });
    report.checks.push('Refreshing after a removal prunes only that library’s tags and comparison candidate, and disables comparisons with fewer than two images');
    expect(report.errors).toEqual([]); report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.message;
    if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, 'organize-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'organize-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, report: path.join(output, 'organize-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
