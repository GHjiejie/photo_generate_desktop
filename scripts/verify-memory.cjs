'use strict';

// Production Electron, React, preload, media protocol and local IPC. All
// libraries/profile and external writer edits belong to this test. Clipboard
// capture stays in this Electron process and never touches the OS clipboard.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LocalLibrary } = require('../local-library.cjs');
const { prepareBatchImport } = require('../batch-import.cjs');

const project = path.resolve(__dirname, '..'), output = path.join(project, '.verification');
const report = { status: 'running', checks: [], errors: [], requests: [], screenshots: [], expectedMediaFailures: [],
  scope: 'Actual production Electron with eight different real imported images, two/single/empty alternate libraries and an isolated profile. Native picker responses, an in-memory clipboard, declared preference-write and IPC failures are substituted only in this test process. The document visibility getter/event is substituted for one real-time pause check because Playwright Electron disables renderer backgrounding. Browser caching is disabled to expose declared stale-image requests after owned external metadata edits. No real library/profile/clipboard/Trash or HTTP service is used.' };
let app, temporary, page, stage = 'preparing', allowedStaleMedia = null;
const prompts = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
  const id = index + 1;
  return [id, { zh: `主体：记忆翻牌 ${id}，虚构成年人物。\n完整中文提示词。${[2, 3, 4].includes(id) ? '\n检索组：memory-set。' : ''}${id === 1 ? '\n唯一：memory-one。' : ''}`,
    en: `Subject: memory fixture ${id}, one fictional adult.\nComplete original English prompt.${[2, 3, 4].includes(id) ? '\nSearch group: memory-set.' : ''}${id === 1 ? '\nUnique: memory-one.' : ''}` }];
}));
const originals = ['001-natural-window.png', '003-korean-fresh.png', '033-autumn-forest.png', '013-scandinavian-minimal.png',
  '012-italian-luxury.png', '031-rainy-night.png', '043-renaissance.png', '053-soft-pastel.png'];

async function fixture(root, count) {
  const source = path.join(path.dirname(root), `${path.basename(root)}-source`), images = path.join(source, 'images');
  await fs.mkdir(images, { recursive: true });
  const records = [];
  for (let id = 1; id <= count; id++) {
    const filename = `${String(id).padStart(3, '0')}-memory.png`;
    await fs.copyFile(path.join(project, 'assets/images', originals[id - 1]), path.join(images, filename));
    records.push({ id, label: `Memory fixture ${id}`, label_en: `Memory portrait ${id}`, label_cn: `记忆参考 ${id}`,
      filename, prompt_en: prompts[id].en, prompt_cn: prompts[id].zh });
  }
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(records, null, 2) + '\n');
  const library = new LocalLibrary(), initial = await library.open(root);
  const plan = await prepareBatchImport({ imageDirectory: images, manifestPath, type: 'photo' });
  const state = await library.importBatch(plan, { expectedVersion: initial.revision, confirmed: true });
  expect(state.batch.imported).toBe(count); return source;
}

async function fingerprint(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
      if (['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json'].includes(relative)) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result[relative] = crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
      else throw new Error(`Unexpected fixture entry: ${relative}`);
    }
  }
  await visit(root); return result;
}

(async () => {
  try {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-memory-ui-')));
    const rootA = path.join(temporary, 'library-a'), rootB = path.join(temporary, 'library-b');
    const rootOne = path.join(temporary, 'library-one'), rootEmpty = path.join(temporary, 'library-empty'), profile = path.join(temporary, 'profile');
    await Promise.all([rootA, rootB, rootOne, rootEmpty, profile, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const sourceA = await fixture(rootA, 8), sourceB = await fixture(rootB, 2), sourceOne = await fixture(rootOne, 1);
    await new LocalLibrary().open(rootEmpty);
    const roots = [rootA, rootB, rootOne, rootEmpty, sourceA, sourceB, sourceOne], originalsBefore = await Promise.all(roots.map(fingerprint));
    let authoritativeA = originalsBefore[0];
    const recordKey = root => `portraitStudio.memoryRecords.v1.${JSON.stringify(['local', '', root])}`;
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: rootA, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    async function launch() {
      app = await electron.launch({ executablePath: require('electron'), args: [project], env });
      page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
      const cache = await app.context().newCDPSession(page);
      await cache.send('Network.enable'); await cache.send('Network.setCacheDisabled', { cacheDisabled: true });
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('request', request => { if (/^https?:/u.test(request.url())) report.requests.push(request.url()); });
      page.on('response', response => {
        if (!response.url().startsWith('portrait-media:') || response.status() < 400) return;
        if (response.status() === 404 && response.url() === allowedStaleMedia) report.expectedMediaFailures.push({ status: response.status(), url: response.url() });
        else report.errors.push(`Media response ${response.status()}: ${response.url()}`);
      });
      await app.evaluate(({ clipboard, shell }) => {
        globalThis.__memoryCopies = [];
        clipboard.writeText = value => { globalThis.__memoryCopies.push(String(value)); };
        clipboard.readText = () => globalThis.__memoryCopies.at(-1) ?? '';
        shell.openPath = () => { throw new Error('Memory game unexpectedly opened an external image'); };
        shell.trashItem = () => { throw new Error('Memory game unexpectedly touched system Trash'); };
      });
      await expect(page.locator('.portrait-card')).toHaveCount(8);
    }
    const cards = () => page.locator('#memoryBoard [data-memory-card]');
    const card = key => page.locator(`#memoryBoard [data-memory-card="${key}"]`);
    const gameCards = () => cards().evaluateAll(elements => elements.map(element => ({ key: element.dataset.memoryCard,
      itemId: Number(element.dataset.itemId), revealed: element.dataset.revealed === 'true', matched: element.dataset.matched === 'true' })));
    const turns = () => page.locator('#memoryTurns').textContent();
    async function decodeBoard() {
      await page.locator('#memoryBoard img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      expect(await page.locator('#memoryBoard img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0))).toBe(true);
      for (const revealed of await page.locator('#memoryBoard [data-revealed="true"]').all()) await expect(revealed).toHaveCSS('opacity', '1');
    }
    const readRecords = root => page.evaluate(key => localStorage.getItem(key), recordKey(root));
    async function appearance(language, theme) {
      await page.locator('#settingsToggle').click();
      await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
      await page.locator(`#themeControl button[data-theme="${theme}"]`).click();
      await page.locator('#settingsPanel').press('Escape');
      await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    async function screenshot(name) { await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name); }
    async function decodeGallery() { await page.locator('.portrait-image').evaluateAll(images => Promise.all(images.map(image => image.decode()))); }
    async function openHub() {
      await page.locator('#openPlayground').click(); await expect(page.locator('#playgroundDialog')).toBeVisible();
      await expect(page.locator('#playMemory')).toBeVisible();
    }
    async function enterMemory() { await page.locator('#playMemory').click(); await expect(page.locator('#memoryGame')).toBeVisible(); }
    async function start(pairCount, restart = false) {
      await page.locator('#memoryDifficulty').selectOption(String(pairCount));
      await page.locator(restart ? '#memoryRestart' : '#memoryStart').click();
      await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'playing');
      await expect(cards()).toHaveCount(pairCount * 2);
      await expect(page.locator('#memoryGame')).toHaveAttribute('data-pair-count', String(pairCount));
    }
    async function closeGame(escape = false) {
      if (escape) await page.keyboard.press('Escape'); else await page.locator('#closePlayground').click();
      await expect(page.locator('#playgroundDialog')).toBeHidden();
    }
    async function matchAll() {
      const snapshot = await gameCards(), groups = new Map();
      for (const entry of snapshot) {
        const group = groups.get(entry.itemId) ?? []; group.push(entry); groups.set(entry.itemId, group);
      }
      expect(groups.size).toBe(snapshot.length / 2);
      for (const group of groups.values()) {
        expect(group).toHaveLength(2);
        if (group.every(entry => entry.matched)) continue;
        await card(group[0].key).click(); await card(group[1].key).click();
        await expect(card(group[0].key)).toHaveAttribute('data-matched', 'true');
        await expect(card(group[1].key)).toHaveAttribute('data-matched', 'true');
      }
      await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'won');
      await expect(page.locator('#memoryWin')).toBeVisible(); await decodeBoard(); return [...groups.keys()];
    }
    async function mismatch({ keyboard = false, wait = true } = {}) {
      const snapshot = await gameCards(), first = snapshot.find(entry => !entry.matched), second = snapshot.find(entry => !entry.matched && entry.itemId !== first.itemId);
      if (keyboard) { await card(first.key).focus(); await page.keyboard.press('Space'); } else await card(first.key).click();
      await expect(card(first.key)).toHaveAttribute('data-revealed', 'true');
      const beforeRepeated = await turns(); await card(first.key).evaluate(element => element.click()); expect(await turns()).toBe(beforeRepeated);
      await card(second.key).click(); await expect(card(second.key)).toHaveAttribute('data-revealed', 'true');
      const third = snapshot.find(entry => entry.key !== first.key && entry.key !== second.key && !entry.matched);
      await expect(card(third.key)).toBeDisabled(); await card(third.key).evaluate(element => element.click());
      await expect(card(third.key)).toHaveAttribute('data-revealed', 'false');
      if (wait) {
        await expect(card(first.key)).toHaveAttribute('data-revealed', 'false', { timeout: 4000 });
        await expect(card(second.key)).toHaveAttribute('data-revealed', 'false');
      }
      return { first, second };
    }
    async function switchLibrary(root, count) {
      await decodeGallery();
      await app.evaluate(({ dialog }, ownedRoot) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ownedRoot] }); }, root);
      await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryConfigure').click();
      await expect(page.locator('.portrait-card')).toHaveCount(count); await expect(page.locator('#playgroundDialog')).toBeHidden();
    }
    async function tag(id) {
      await page.locator(`.portrait-card[data-id="${id}"]`).click(); await expect(page.locator('#detailDialog')).toBeVisible();
      await page.locator('#tagInput').fill('memory-tag'); await page.locator('#tagInput').press('Enter');
      await expect(page.locator('.tag-chip')).toHaveCount(1); await page.locator('#closeDialog').click();
    }
    async function writeLatest(id, marker) {
      const writer = new LocalLibrary(); let latest;
      await decodeGallery();
      await expect.poll(async () => {
        try {
          const state = await writer.open(rootA), item = state.items.find(item => item.id === id);
          latest = await writer.update({ id, label: item.label, type: item.type,
            prompts: { en: item.prompts.en + `\nLatest external English ${marker}.`, zh: item.prompts.zh + `\n最新外部中文 ${marker}。` },
            expectedVersion: state.revision, expectedRevision: item.revision }); return 'done';
        } catch (error) { if (error.code !== 'LIBRARY_BUSY') throw error; return 'busy'; }
      }, { timeout: 10000, intervals: [100, 250, 500] }).toBe('done');
      prompts[id] = latest.items.find(item => item.id === id).prompts; authoritativeA = await fingerprint(rootA); return prompts[id];
    }

    await launch(); await appearance('zh', 'dark'); await decodeGallery();
    stage = 'scope and unavailable pools';
    for (const id of [2, 3, 4]) await tag(id);
    for (const id of [2, 3, 5]) await page.locator(`.portrait-card[data-id="${id}"] .favorite-button`).click();
    await page.locator('#searchInput').fill('memory-set'); await page.locator('#tagFilter').selectOption('memory-tag'); await page.locator('#favoriteImages').click();
    await expect(page.locator('.portrait-card')).toHaveCount(2); await openHub(); await enterMemory();
    expect(await page.locator('#memoryDifficulty option').evaluateAll(options => options.map(option => option.value))).toEqual(['2']);
    await start(2); expect([...new Set((await gameCards()).map(entry => entry.itemId))].sort()).toEqual([2, 3]);
    await matchAll(); await closeGame(true); await expect(page.locator('#openPlayground')).toBeFocused();
    await page.locator('#resetBrowseFilters').click(); await page.locator('#searchInput').fill('memory-one'); await openHub();
    await expect(page.locator('#playMemory')).toBeDisabled(); await closeGame();
    await page.locator('#searchInput').fill('no-owned-memory-results'); await expect(page.locator('#openPlayground')).toBeDisabled();
    await page.locator('#clearSearch').click(); await expect(page.locator('.portrait-card')).toHaveCount(8);
    report.checks.push('The game draws only from the intersection of launched search/favorite/tag filters, adapts pair difficulty to unique available images, disables one-image and empty pools, and Escape restores launcher focus');

    stage = 'preview mismatch keyboard and records';
    await openHub(); await enterMemory(); await start(4);
    const originalCards = await gameCards(); expect(new Set(originalCards.map(entry => entry.key)).size).toBe(8);
    expect(originalCards.every(entry => !entry.revealed && !entry.matched)).toBe(true);
    const hiddenLabels = await cards().evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
    expect(hiddenLabels.every(label => label && !/Memory portrait|记忆参考/u.test(label))).toBe(true);
    const beforePreview = await turns(); await page.locator('#memoryPreview').click();
    await expect(page.locator('#memoryGame')).toHaveAttribute('data-previewing', 'true'); await expect(page.locator('#memoryPreview')).toBeDisabled();
    await expect.poll(async () => (await gameCards()).every(entry => entry.revealed)).toBe(true);
    expect(await turns()).toBe(beforePreview); await decodeBoard(); await screenshot('memory-preview-zh-dark.png');
    await expect(page.locator('#memoryGame')).toHaveAttribute('data-previewing', 'false', { timeout: 5000 });
    await expect(page.locator('#memoryPreview')).toBeDisabled(); expect((await gameCards()).every(entry => !entry.revealed)).toBe(true);
    await mismatch({ keyboard: true }); await matchAll();
    await expect.poll(async () => JSON.parse(await readRecords(rootA))?.['4']?.turns).toBe(5);
    await expect(page.locator('#memoryBest')).toContainText('5');
    await screenshot('memory-win-zh-dark.png');
    await start(4, true); expect((await gameCards()).every(entry => !entry.revealed && !entry.matched)).toBe(true);
    await expect(page.locator('#memoryPreview')).toBeEnabled(); await matchAll();
    await expect.poll(async () => JSON.parse(await readRecords(rootA))?.['4']?.turns).toBe(4);
    const bestFour = JSON.parse(await readRecords(rootA))['4']; expect(Number.isFinite(bestFour.completedAt)).toBe(true);
    await start(4, true); await mismatch(); await matchAll(); expect(JSON.parse(await readRecords(rootA))['4']).toEqual(bestFour);
    await closeGame();
    report.checks.push('Every chosen image has exactly two unique shuffled cards; hidden card names reveal no image identity, one-use two-second preview does not score, native keyboard Space flips, repeated cards and a rapid third click are ignored, mismatches resolve after one second, restart resets the board, exact matching improves best score and a worse result preserves its timestamp');

    stage = 'timers and unmount';
    await openHub(); await enterMemory(); await start(4); const frozenMismatch = await mismatch({ wait: false });
    await page.evaluate(() => {
      globalThis.__memoryVisibility = { hidden: true, original: Object.getOwnPropertyDescriptor(document, 'hidden') };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => globalThis.__memoryVisibility.hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(1400); await expect(card(frozenMismatch.first.key)).toHaveAttribute('data-revealed', 'true');
    await page.evaluate(() => { globalThis.__memoryVisibility.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(card(frozenMismatch.first.key)).toHaveAttribute('data-revealed', 'false', { timeout: 4000 });
    await page.evaluate(() => {
      const { original } = globalThis.__memoryVisibility;
      if (original) Object.defineProperty(document, 'hidden', original); else delete document.hidden;
      delete globalThis.__memoryVisibility; document.dispatchEvent(new Event('visibilitychange'));
    });
    await start(4, true); await page.locator('#memoryPreview').click(); await expect(page.locator('#memoryGame')).toHaveAttribute('data-previewing', 'true');
    await page.locator('#playgroundBack').click(); await expect(page.locator('#memoryGame')).toHaveCount(0);
    await enterMemory(); await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'idle');
    await page.waitForTimeout(2200); await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'idle');
    await start(4); await mismatch({ wait: false }); await closeGame(); await page.waitForTimeout(1200);
    await openHub(); await enterMemory(); await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'idle'); await closeGame();
    report.checks.push('A declared document visibility getter/event substitution pauses a real one-second mismatch timer while hidden and restarts it on return; Back and close unmount pending preview/mismatch timers, and reopened games stay idle without old callbacks or progress');

    stage = 'eight-pair board and compact layout';
    await appearance('en', 'light'); await page.setViewportSize({ width: 1080, height: 720 }); await openHub();
    for (const selector of ['#playDuel', '#playSlideshow', '#playMemory']) await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    await screenshot('memory-hub-en-light-compact.png'); await enterMemory(); await start(8); await screenshot('memory-board-en-light-compact.png');
    const dialogBox = await page.locator('#playgroundDialog').boundingBox();
    for (const selector of ['#closePlayground', '#playgroundBack', '#memoryDifficulty', '#memoryRestart', '#memoryPreview', '#memoryBoard']) {
      const box = await page.locator(selector).boundingBox(); expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(dialogBox.x - 1); expect(box.y).toBeGreaterThanOrEqual(dialogBox.y - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
    }
    await page.locator('#memoryPreview').click(); await decodeBoard();
    for (const image of await page.locator('#memoryBoard img').all()) await expect(image).toHaveCSS('object-fit', 'contain');
    await screenshot('memory-preview-en-light-compact.png');
    await expect(page.locator('#memoryGame')).toHaveAttribute('data-previewing', 'false', { timeout: 5000 });
    const inspirations = await matchAll(); expect(inspirations.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect.poll(async () => JSON.parse(await readRecords(rootA))?.['8']?.turns).toBe(8);
    await expect(page.locator('#memoryInspirationPicker')).toBeFocused();
    for (const selector of ['#memoryInspirationPicker', '#memoryFavorite', '#memoryDetails', '#memoryCreativeLab']) await expect(page.locator(selector)).toBeInViewport({ ratio: 1 });
    await screenshot('memory-win-en-light-compact.png'); await page.setViewportSize({ width: 1440, height: 920 });
    await page.locator('#memoryInspirationPicker').selectOption('3'); const favoriteBefore = await page.locator('#memoryFavorite').getAttribute('aria-pressed');
    await page.locator('#memoryFavorite').click(); await expect(page.locator('#memoryFavorite')).toHaveAttribute('aria-pressed', favoriteBefore === 'true' ? 'false' : 'true');
    const latestDetail = await writeLatest(3, 'memory-detail');
    await page.locator('#memoryDetails').click(); await expect(page.locator('#playgroundDialog')).toBeHidden();
    await expect(page.locator('#detailDialog')).toBeVisible(); await expect(page.locator('#detailIndex')).toHaveText('003');
    await expect(page.locator('#detailPrompt')).toHaveText(latestDetail.en); await page.locator('#closeDialog').click();
    await openHub(); await enterMemory(); await start(8); await matchAll(); await page.locator('#memoryInspirationPicker').selectOption('2');
    await writeLatest(2, 'memory-remix'); await page.locator('#memoryCreativeLab').click(); await expect(page.locator('#playgroundDialog')).toBeHidden();
    await expect(page.locator('#creativeLabDialog')).toBeVisible(); await expect(page.locator('[data-lab-source]')).toHaveCount(1);
    await expect(page.locator('[data-lab-source="2"]')).toContainText('Latest external English memory-remix.'); await page.locator('#closeCreativeLab').click();
    report.checks.push('All three home mode entries and the sixteen-card eight-pair board fit the 1080×720 dialog in English/light; revealed cards retain opacity one and decoded full contained images; winning scrolls and focuses the inspiration picker with all actions in view; winners select any played inspiration, toggle its favorite and hand off authoritative latest prompts to details and remix after owned external edits');

    stage = 'stale image retry and handoff failure';
    await openHub(); allowedStaleMedia = await page.locator('.portrait-card[data-id="1"] .portrait-image').getAttribute('src');
    await writeLatest(1, 'memory-retry'); expect((await page.evaluate(() => window.portraitStudio.libraryList())).ok).toBe(true);
    await enterMemory(); await page.locator('#memoryDifficulty').selectOption('8'); await page.locator('#memoryStart').click();
    await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'error'); await expect(page.locator('#memoryRetry')).toBeVisible();
    const failedCards = JSON.parse(await page.locator('#memoryGame').getAttribute('data-card-order'));
    expect(failedCards).toHaveLength(16); await page.locator('#memoryRetry').click(); await expect(page.locator('#memoryGame')).toHaveAttribute('data-status', 'playing');
    expect((await gameCards()).map(({ key, itemId }) => ({ key, itemId }))).toEqual(failedCards);
    expect(report.expectedMediaFailures.length).toBeGreaterThanOrEqual(1); allowedStaleMedia = null;
    await matchAll(); await page.locator('#memoryInspirationPicker').selectOption('1');
    await app.evaluate(({ ipcMain }) => {
      globalThis.__memoryLibraryGet = ipcMain._invokeHandlers.get('library-get');
      if (typeof globalThis.__memoryLibraryGet !== 'function') throw new Error('Owned IPC capture unavailable');
      ipcMain.removeHandler('library-get'); ipcMain.handle('library-get', () => ({ ok: false, error: { code: 'IO_ERROR', message: 'Owned temporary memory handoff failure' } }));
    });
    await page.locator('#memoryDetails').click(); await expect(page.locator('#playgroundDialog')).toBeVisible();
    await expect(page.locator('#memoryWin')).toBeVisible(); await expect(page.locator('#playgroundFeedback')).toHaveAttribute('role', 'alert');
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('library-get'); ipcMain.handle('library-get', globalThis.__memoryLibraryGet); delete globalThis.__memoryLibraryGet; });
    await closeGame();
    report.checks.push('A declared stale image fails actual media preloading and blocks guessing; Retry reads latest same-ID records, reloads successfully and preserves the drawn cards; failed detail handoff keeps the won game open with visible modal alert feedback');

    stage = 'persistence and library isolation';
    const persistedA = await readRecords(rootA); await app.close(); app = null; await launch();
    expect(await readRecords(rootA)).toBe(persistedA); await openHub(); await enterMemory(); await page.locator('#memoryDifficulty').selectOption('4');
    await expect(page.locator('#memoryBest')).toContainText('4'); await closeGame(); await switchLibrary(rootB, 2);
    expect(await readRecords(rootB)).toBeNull(); await openHub(); await enterMemory(); await expect(page.locator('#memoryBest')).not.toContainText('4');
    await start(2); await matchAll(); await expect.poll(async () => JSON.parse(await readRecords(rootB))?.['2']?.turns).toBe(2);
    const persistedB = await readRecords(rootB); await closeGame(); await switchLibrary(rootOne, 1); await openHub();
    await expect(page.locator('#playMemory')).toBeDisabled(); await closeGame(); await switchLibrary(rootEmpty, 0); await expect(page.locator('#openPlayground')).toBeDisabled();
    await switchLibrary(rootA, 8); expect(await readRecords(rootA)).toBe(persistedA); expect(await readRecords(rootB)).toBe(persistedB);
    report.checks.push('Best scores survive an actual Electron restart; overlapping image IDs in another library receive independent records, one-image/empty libraries disable play, and returning restores original scoped scores');

    stage = 'storage failure and recovery';
    await page.evaluate(() => {
      globalThis.__memorySetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('portraitStudio.memoryRecords.')) throw new DOMException('Owned memory score quota test', 'QuotaExceededError');
        return globalThis.__memorySetItem.call(this, key, value);
      };
    });
    await openHub(); await enterMemory(); await start(6); await matchAll();
    await expect(page.locator('#memoryStorageWarning')).toBeVisible(); await expect(page.locator('#memoryStorageWarning')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#memoryBest')).toContainText('6'); expect(await readRecords(rootA)).toBe(persistedA); await closeGame();
    await switchLibrary(rootB, 2); await switchLibrary(rootA, 8); await openHub(); await enterMemory(); await page.locator('#memoryDifficulty').selectOption('6');
    await expect(page.locator('#memoryBest')).toContainText('6'); await expect(page.locator('#memoryStorageWarning')).toHaveAttribute('role', 'alert');
    await page.evaluate(() => { Storage.prototype.setItem = globalThis.__memorySetItem; delete globalThis.__memorySetItem; });
    const storageRecoveryStarted = Date.now();
    await start(6); await mismatch(); await matchAll();
    await expect.poll(async () => JSON.parse(await readRecords(rootA))?.['6']?.turns).toBe(6);
    await expect(page.locator('#memoryStorageWarning')).toHaveCount(0);
    expect(JSON.parse(await readRecords(rootA))['6'].completedAt).toBeLessThan(storageRecoveryStarted);
    const recoveredA = await readRecords(rootA); await closeGame();
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(8); expect(await readRecords(rootA)).toBe(recoveredA);
    await page.evaluate(key => localStorage.setItem(key, '{owned malformed score JSON'), recordKey(rootA)); await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(8); await openHub(); await enterMemory(); await start(2); await matchAll(); await closeGame();
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: recordKey(rootA), value: recoveredA });
    report.checks.push('A preference write failure leaves the completed game usable, shows an inline alert and retains scoped session bests across library switches while preserving disk state; a later worse completion retries saving the retained better score once storage recovers and clears the warning; reload recovers saved records, malformed JSON still allows play and a fresh score save');

    stage = 'preservation';
    expect(await fingerprint(rootA)).toEqual(authoritativeA);
    const finalA = await fingerprint(rootA);
    for (const [relative, hash] of Object.entries(originalsBefore[0])) if (relative !== '.portrait-studio/library.json') expect(finalA[relative]).toBe(hash);
    for (let index = 1; index < roots.length; index++) expect(await fingerprint(roots[index])).toEqual(originalsBefore[index]);
    expect(report.errors).toEqual([]); expect(report.requests).toEqual([]);
    report.checks.push('Game operations preserve every source and imported image byte and all library metadata except declared owned external-writer prompt edits; no real profile/clipboard/Trash/external opener, renderer error, unexpected media failure or HTTP service request occurs');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.stage = stage; report.failure = error.stack ?? error.message;
    if (page) await page.screenshot({ path: path.join(output, 'memory-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app?.close(); if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'memory-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, requests: report.requests, report: path.join(output, 'memory-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
