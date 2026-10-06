'use strict';

// Production Electron, React, preload, media protocol and local IPC. Every
// library/profile is an owned temporary fixture; native copy is captured only
// in this Electron process's memory and never reads or writes the OS clipboard.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LocalLibrary } = require('../local-library.cjs');
const { prepareBatchImport } = require('../batch-import.cjs');

const project = path.resolve(__dirname, '..'), output = path.join(project, '.verification');
const report = {
  status: 'running', checks: [], errors: [], requests: [], screenshots: [], expectedMediaFailures: [],
  scope: 'Actual production Electron with five real image fixtures, single/empty alternate libraries and an isolated profile; favorites/tags/drafts stay in that profile. Native picker responses and an in-memory clipboard are substituted; one owned IPC failure tests modal error feedback. Chromium caching is disabled only for this test page to exercise one declared stale-image 404 after an owned external metadata edit; all source/image bytes remain unchanged.'
};
let app, temporary, stage = 'preparing';
const prompts = Object.fromEntries([1, 2, 3, 4, 5].map(id => [id, {
  zh: `主体：playground fixture ${id}，虚构成年人物。\n保留完整提示词、标点和所有换行。\n\n光线：柔和窗光。\n构图：完整原始图片。${[2, 3, 4].includes(id) ? '\n检索组：scope-set。' : ''}${id === 1 ? '\n唯一检索：id-only-one。' : ''}`,
  en: `Subject: playground fixture ${id}, one fictional adult.\nKeep the complete prompt, punctuation and every newline.\n\nLighting: Soft window light.\nComposition: Preserve the full original image.${[2, 3, 4].includes(id) ? '\nSearch group: scope-set.' : ''}${id === 1 ? '\nUnique search: id-only-one.' : ''}`
}]));

async function fixture(root, entries) {
  const source = path.join(path.dirname(root), `${path.basename(root)}-source`), images = path.join(source, 'images');
  await fs.mkdir(images, { recursive: true });
  const records = [];
  for (const [id, english, chinese, original] of entries) {
    const filename = `${String(id).padStart(3, '0')}-playground.png`;
    await fs.copyFile(path.join(project, 'assets/images', original), path.join(images, filename));
    records.push({ id, label: `Playground fixture ${id}`, label_en: english, label_cn: chinese, filename,
      prompt_en: prompts[id].en, prompt_cn: prompts[id].zh });
  }
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(records, null, 2) + '\n');
  const library = new LocalLibrary(), initial = await library.open(root);
  const plan = await prepareBatchImport({ imageDirectory: images, manifestPath, type: 'photo' });
  const state = await library.importBatch(plan, { expectedVersion: initial.revision, confirmed: true });
  expect(state.batch.imported).toBe(entries.length);
  return { state, source };
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
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-playground-ui-')));
    const rootA = path.join(temporary, 'library-a'), rootOne = path.join(temporary, 'library-one'), rootEmpty = path.join(temporary, 'library-empty'), profile = path.join(temporary, 'profile');
    await Promise.all([rootA, rootOne, rootEmpty, profile, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const createdA = await fixture(rootA, [
      [1, 'Zulu', '五号', '001-natural-window.png'], [2, 'Bravo', '二号', '003-korean-fresh.png'],
      [3, 'Alpha', '一号', '033-autumn-forest.png'], [4, 'Charlie', '三号', '013-scandinavian-minimal.png'],
      [5, 'Delta', '四号', '012-italian-luxury.png']
    ]);
    const createdOne = await fixture(rootOne, [[1, 'Other library portrait', '另一仓库肖像', '031-rainy-night.png']]);
    await new LocalLibrary().open(rootEmpty);
    const originalA = await fingerprint(rootA), originalOne = await fingerprint(rootOne), originalEmpty = await fingerprint(rootEmpty);
    const sourceA = await fingerprint(createdA.source), sourceOne = await fingerprint(createdOne.source);
    let authoritativeA = originalA;
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: rootA, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: require('electron'), args: [project], env });
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
    const cacheControl = await app.context().newCDPSession(page);
    await cacheControl.send('Network.enable'); await cacheControl.send('Network.setCacheDisabled', { cacheDisabled: true });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (/^https?:/u.test(request.url())) report.requests.push(request.url()); });
    let allowedStaleMedia = null;
    page.on('response', response => {
      if (!response.url().startsWith('portrait-media:') || response.status() < 400) return;
      if (response.status() === 404 && response.url() === allowedStaleMedia) report.expectedMediaFailures.push({ status: response.status(), url: response.url() });
      else report.errors.push(`Media response ${response.status()}: ${response.url()}`);
    });
    await app.evaluate(({ clipboard, shell }) => {
      globalThis.__playgroundCopies = [];
      clipboard.writeText = value => { globalThis.__playgroundCopies.push(String(value)); };
      clipboard.readText = () => globalThis.__playgroundCopies.at(-1) ?? '';
      shell.openPath = () => { throw new Error('Playground unexpectedly opened an external image'); };
      shell.trashItem = () => { throw new Error('Playground unexpectedly touched system Trash'); };
    });
    const cards = page.locator('.portrait-card');
    const ids = () => cards.evaluateAll(elements => elements.map(element => Number(element.dataset.id)));
    const order = expected => expect.poll(ids).toEqual(expected);
    const duelPair = () => page.locator('[data-duel-card]').evaluateAll(elements => elements.map(element => Number(element.dataset.duelCard)));
    const currentSlide = async () => Number(await page.locator('#slideshow').getAttribute('data-current-id'));
    const expectSlide = id => expect(page.locator('#slideshow')).toHaveAttribute('data-current-id', String(id));
    async function decodeGallery() { await page.locator('.portrait-image').evaluateAll(images => Promise.all(images.map(image => image.decode()))); }
    async function appearance(language, theme) {
      await page.locator('#settingsToggle').click();
      await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
      await page.locator(`#themeControl button[data-theme="${theme}"]`).click();
      await page.locator('#settingsPanel').press('Escape');
      await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    async function screenshot(name) {
      await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name);
    }
    async function openHub() {
      await page.locator('#openPlayground').click(); await expect(page.locator('#playgroundDialog')).toBeVisible();
      await expect(page.locator('#playDuel')).toBeVisible(); await expect(page.locator('#playSlideshow')).toBeVisible();
    }
    async function closePlayground(escape = false) {
      if (escape) await page.keyboard.press('Escape'); else await page.locator('#closePlayground').click();
      await expect(page.locator('#playgroundDialog')).toBeHidden();
    }
    async function startDuel() {
      await page.locator('#playDuel').click(); await expect(page.locator('#duelStart')).toBeVisible();
      await page.locator('#duelStart').click(); await expect(page.locator('[data-duel-card]')).toHaveCount(2);
    }
    async function completeDuel(pool) {
      const seen = new Set(), eliminated = new Set(); let choices = 0;
      while (!await page.locator('#duelWinner').count()) {
        const pair = await duelPair(); expect(pair).toHaveLength(2); expect(pair[0]).not.toBe(pair[1]);
        for (const id of pair) { expect(pool).toContain(id); expect(eliminated.has(id)).toBe(false); seen.add(id); }
        await page.locator(`[data-duel-pick="${pair[0]}"]`).click(); eliminated.add(pair[1]); choices++;
        expect(choices).toBeLessThanOrEqual(pool.length - 1);
      }
      const winner = Number(await page.locator('#duelWinner').getAttribute('data-winner-id'));
      expect(pool).toContain(winner); expect(eliminated.has(winner)).toBe(false);
      expect(choices).toBe(pool.length - 1); expect([...seen].sort((a, b) => a - b)).toEqual([...pool].sort((a, b) => a - b));
      return winner;
    }
    async function startSlideshow(first) {
      await page.locator('#playSlideshow').click(); await expect(page.locator('#slideshow')).toBeVisible();
      await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false');
      if (first != null) await expectSlide(first);
      await page.locator('#slideshowImage').evaluate(image => image.decode());
      await expect(page.locator('#slideshowImage')).toHaveCSS('object-fit', 'contain');
      await fittedSlide();
    }
    async function fittedSlide() {
      const viewport = await page.locator('#slideshowViewport').boundingBox(), image = await page.locator('#slideshowImage').boundingBox();
      expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0);
      expect(image.x).toBeGreaterThanOrEqual(viewport.x - 1); expect(image.y).toBeGreaterThanOrEqual(viewport.y - 1);
      expect(image.x + image.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
      expect(image.y + image.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
    }
    async function writeLatest(id, marker) {
      const writer = new LocalLibrary(); let latest;
      await decodeGallery();
      await expect.poll(async () => {
        try {
          const state = await writer.open(rootA), item = state.items.find(item => item.id === id);
          latest = await writer.update({ id, label: item.label, type: item.type,
            prompts: { en: item.prompts.en + `\nLatest external English ${marker}.`, zh: item.prompts.zh + `\n最新外部中文 ${marker}。` },
            expectedVersion: state.revision, expectedRevision: item.revision });
          return 'done';
        } catch (error) { if (error.code !== 'LIBRARY_BUSY') throw error; return 'busy'; }
      }, { timeout: 10000, intervals: [100, 250, 500] }).toBe('done');
      prompts[id] = latest.items.find(item => item.id === id).prompts;
      authoritativeA = await fingerprint(rootA); return prompts[id];
    }
    async function switchLibrary(root, count) {
      await app.evaluate(({ dialog }, ownedRoot) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [ownedRoot] }); }, root);
      await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryConfigure').click();
      await expect(cards).toHaveCount(count); await expect(page.locator('#playgroundDialog')).toBeHidden();
    }
    async function tag(id) {
      await page.locator(`.portrait-card[data-id="${id}"]`).click(); await expect(page.locator('#detailDialog')).toBeVisible();
      await page.locator('#tagInput').fill('play-set'); await page.locator('#tagInput').press('Enter');
      await expect(page.locator('.tag-chip')).toHaveCount(1); await page.locator('#closeDialog').click();
    }

    stage = 'scoped-hub';
    await expect(cards).toHaveCount(5); await decodeGallery(); await appearance('zh', 'dark');
    await order([1, 2, 3, 4, 5]); await page.locator('#gallerySort').selectOption('number-desc'); await order([5, 4, 3, 2, 1]);
    for (const id of [2, 3, 4]) await tag(id);
    for (const id of [2, 3, 5]) await page.locator(`.portrait-card[data-id="${id}"] .favorite-button`).click();
    await page.locator('#searchInput').fill('scope-set'); await page.locator('#tagFilter').selectOption('play-set');
    await page.locator('#favoriteImages').click(); await order([3, 2]); await openHub();
    await screenshot('playground-hub-zh-dark.png'); await startSlideshow(3);
    await expect(page.locator('#slideshowPosition')).toContainText('1 / 2'); await page.locator('#slideshowNext').click(); await expectSlide(2);
    await expect(page.locator('#slideshowPosition')).toContainText('2 / 2'); await page.locator('#slideshowNext').click(); await expectSlide(3);
    await page.locator('#slideshowFavorite').click(); await expect(page.locator('#slideshowFavorite')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#slideshowNext').click(); await expectSlide(2); await page.locator('#slideshowNext').click(); await expectSlide(3);
    await page.locator('#slideshowFavorite').click(); await expect(page.locator('#slideshowFavorite')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#playgroundBack').click(); await expect(page.locator('#slideshow')).toHaveCount(0);
    await startDuel(); await completeDuel([3, 2]); await closePlayground(); await order([3, 2]);
    report.checks.push('Both modes use the intersection of current search, favorite and tag filters; slideshow follows descending sort and wraps, and its launched pool stays fixed while a favorite is toggled');

    stage = 'empty-and-single-filter';
    await openHub(); await startSlideshow(3); await page.locator('#slideshowFavorite').click();
    await page.locator('#slideshowNext').click(); await expectSlide(2); await page.locator('#slideshowFavorite').click();
    await closePlayground(true); await order([]); await expect(page.locator('#openPlayground')).toBeDisabled();
    await expect(page.locator('#searchInput')).toBeFocused();
    await page.locator('#allImages').click(); await order([4, 3, 2]);
    for (const id of [2, 3]) await page.locator(`.portrait-card[data-id="${id}"] .favorite-button`).click();
    await page.locator('#resetBrowseFilters').click(); await page.locator('#searchInput').fill('id-only-one'); await order([1]);
    await openHub(); await expect(page.locator('#playDuel')).toBeDisabled(); await startSlideshow(1);
    for (const id of ['slideshowPlay', 'slideshowPrevious', 'slideshowNext', 'slideshowShuffle']) await expect(page.locator(`#${id}`)).toBeDisabled();
    await closePlayground(true); await expect(page.locator('#openPlayground')).toBeFocused();
    await page.locator('#searchInput').fill('owned-no-match-7b92896'); await order([]); await expect(page.locator('#openPlayground')).toBeDisabled();
    await page.locator('#clearSearch').click(); await order([5, 4, 3, 2, 1]);
    await page.locator('#beginBatchDelete').click(); await page.locator('.portrait-card[data-id="2"]').click();
    await expect(page.locator('#openPlayground')).toBeDisabled(); await expect(page.locator('#playgroundDialog')).toBeHidden();
    await page.locator('#exitSelection').click(); await expect(page.locator('#openPlayground')).toBeEnabled();
    report.checks.push('Empty results disable the hub; one result keeps manual slideshow available and disables duel/playback/navigation/shuffle; batch selection suspends entry, Escape restores topbar focus, and removing every visible favorite restores search focus when the launcher becomes disabled');

    stage = 'duel-tournament';
    await openHub(); await startDuel(); const firstPair = await duelPair();
    await expect(page.locator('#duelUndo')).toBeDisabled(); await page.locator(`[data-duel-pick="${firstPair[0]}"]`).click();
    await page.locator('#duelUndo').click(); expect(await duelPair()).toEqual(firstPair);
    await page.locator('#duelRestart').click(); await expect(page.locator('[data-duel-card]')).toHaveCount(2); await expect(page.locator('#duelUndo')).toBeDisabled();
    const winner = await completeDuel([1, 2, 3, 4, 5]);
    await screenshot('playground-duel-winner-zh-dark.png');
    await page.locator('#duelUndo').click(); const finalPair = await duelPair(); expect(finalPair).toContain(winner);
    await page.locator(`[data-duel-pick="${winner}"]`).click(); await expect(page.locator('#duelWinner')).toHaveAttribute('data-winner-id', String(winner));
    const oldFavorite = await page.locator('#duelFavorite').getAttribute('aria-pressed'); await page.locator('#duelFavorite').click();
    await expect(page.locator('#duelFavorite')).toHaveAttribute('aria-pressed', oldFavorite === 'true' ? 'false' : 'true');
    const winnerLatest = await writeLatest(winner, 'duel-detail');
    await page.locator('#duelOpenDetail').click(); await expect(page.locator('#playgroundDialog')).toBeHidden();
    await expect(page.locator('#detailDialog')).toBeVisible(); await expect(page.locator('#detailIndex')).toHaveText(String(winner).padStart(3, '0'));
    await expect(page.locator('#detailPrompt')).toHaveText(winnerLatest.zh); await page.locator('#closeDialog').click();
    await openHub(); await startDuel(); const remixWinner = await completeDuel([1, 2, 3, 4, 5]);
    const remixLatest = await writeLatest(remixWinner, 'duel-remix');
    await page.locator('#duelCreativeLab').click(); await expect(page.locator('#playgroundDialog')).toBeHidden();
    await expect(page.locator('#creativeLabDialog')).toBeVisible(); await expect(page.locator('[data-lab-source]')).toHaveCount(1);
    await expect(page.locator(`[data-lab-source="${remixWinner}"]`)).toContainText('最新外部中文 duel-remix。');
    expect(remixLatest.zh).toContain('duel-remix'); await page.locator('#closeCreativeLab').click();
    report.checks.push('Five unique entrants finish in exactly four real decisions with odd byes; eliminated portraits never return, undo restores an exact prior pair and works after winning, restart clears decisions, winner favorites work, and detail/remix fetch authoritative externally updated records');

    stage = 'slideshow-keyboard-and-copy';
    await appearance('en', 'light'); await page.locator('#gallerySort').selectOption('name-asc'); await order([3, 2, 4, 5, 1]);
    await openHub(); await screenshot('playground-hub-en-light.png'); await startDuel();
    await page.locator('.duel-pair img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    for (const image of await page.locator('.duel-pair img').all()) await expect(image).toHaveCSS('object-fit', 'contain');
    await screenshot('playground-duel-en-light.png'); await page.locator('#playgroundBack').click();
    await startSlideshow(3); await page.locator('#slideshowPromptToggle').click();
    await expect(page.locator('#slideshowPrompt')).toHaveText(prompts[3].en); await page.locator('#slideshowCopy').click();
    await expect.poll(() => app.evaluate(() => globalThis.__playgroundCopies.at(-1))).toBe(prompts[3].en);
    await expect(page.locator('#playgroundFeedback')).toHaveAttribute('role', 'status');
    const copiesBeforeFault = await app.evaluate(() => globalThis.__playgroundCopies.length);
    await app.evaluate(({ clipboard }) => { globalThis.__playgroundCopyCapture = clipboard.writeText; clipboard.writeText = () => { throw new Error('Owned in-memory copy failure'); }; });
    await page.locator('#slideshowCopy').click(); await expect(page.locator('#playgroundFeedback')).toBeVisible();
    await expect(page.locator('#playgroundFeedback')).toHaveAttribute('role', 'alert');
    expect(await app.evaluate(() => globalThis.__playgroundCopies.length)).toBe(copiesBeforeFault);
    await expect(page.locator('#slideshowPrompt')).toHaveText(prompts[3].en);
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.__playgroundCopyCapture; delete globalThis.__playgroundCopyCapture; });
    await page.locator('#slideshowCopy').click(); await expect(page.locator('#playgroundFeedback')).toHaveAttribute('role', 'status');
    await page.locator('#slideshowNext').click(); await expectSlide(2); await page.locator('#slideshowPrevious').click(); await expectSlide(3);
    await page.locator('#slideshowViewport').focus(); await page.keyboard.press('ArrowLeft'); await expectSlide(1);
    await page.keyboard.press('ArrowRight'); await expectSlide(3); await page.keyboard.press('Shift+ArrowRight'); await expectSlide(3);
    await page.locator('#slideshowInterval').focus(); await page.keyboard.press('ArrowLeft'); await expectSlide(3);
    await screenshot('playground-slideshow-en-light.png');
    await page.setViewportSize({ width: 1080, height: 720 });
    await fittedSlide();
    const dialogBox = await page.locator('#playgroundDialog').boundingBox();
    for (const selector of ['#closePlayground', '#playgroundBack', '#slideshowPlay', '#slideshowCreativeLab', '#slideshowCopy']) {
      const box = await page.locator(selector).boundingBox(); expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(dialogBox.x - 1); expect(box.y).toBeGreaterThanOrEqual(dialogBox.y - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 1);
    }
    await screenshot('playground-slideshow-en-light-compact.png'); await page.setViewportSize({ width: 1440, height: 920 });
    await closePlayground(); await page.locator('#gallerySort').selectOption('default'); await appearance('zh', 'dark'); await openHub(); await startSlideshow(1);
    await page.locator('#slideshowPromptToggle').click(); await expect(page.locator('#slideshowPrompt')).toHaveText(prompts[1].zh);
    await page.locator('#slideshowCopy').click(); await expect.poll(() => app.evaluate(() => globalThis.__playgroundCopies.at(-1))).toBe(prompts[1].zh);
    await screenshot('playground-slideshow-zh-dark.png');
    report.checks.push('Slideshow starts paused in localized name order, shows the entire contained original image and complete bilingual prompt, captures exact native copy in test memory with modal success/failure feedback, wraps manual buttons/arrow keys and ignores modifier/editable shortcuts; Chinese/dark and English/light screens plus 1080×720 control bounds verified');

    stage = 'slideshow-shuffle-and-timers';
    const shuffleStart = await currentSlide(); await page.locator('#slideshowShuffle').click(); await expect(page.locator('#slideshowShuffle')).toHaveAttribute('aria-pressed', 'true');
    await expectSlide(shuffleStart); const shuffled = [shuffleStart];
    for (let index = 1; index < 5; index++) { await page.locator('#slideshowNext').click(); shuffled.push(await currentSlide()); }
    expect(new Set(shuffled).size).toBe(5); expect([...shuffled].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    const lastShuffled = await currentSlide(); await page.locator('#slideshowNext').click(); expect(await currentSlide()).not.toBe(lastShuffled);
    const beforeRestore = await currentSlide(); await page.locator('#slideshowShuffle').click(); await expectSlide(beforeRestore);
    await expect(page.locator('#slideshowShuffle')).toHaveAttribute('aria-pressed', 'false');
    const favoriteBefore = await page.locator('#slideshowFavorite').getAttribute('aria-pressed'); await page.locator('#slideshowFavorite').click();
    await expect(page.locator('#slideshowFavorite')).toHaveAttribute('aria-pressed', favoriteBefore === 'true' ? 'false' : 'true');
    await page.locator('#slideshowInterval').selectOption('3'); const beforePlay = await currentSlide();
    await page.locator('#slideshowViewport').focus(); await page.keyboard.press('Space'); await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'true');
    await expect.poll(currentSlide, { timeout: 6000, intervals: [100, 200, 500] }).not.toBe(beforePlay);
    await page.locator('#slideshowPlay').click(); await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false');
    const paused = await currentSlide(); await page.waitForTimeout(3300); await expectSlide(paused);
    await page.locator('#slideshowPlay').click(); await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'true');
    await page.locator('#playgroundBack').click(); await expect(page.locator('#slideshow')).toHaveCount(0); await startSlideshow(1);
    await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false'); await page.waitForTimeout(3300); await expectSlide(1);
    await page.locator('#slideshowPlay').click(); await closePlayground(); await page.waitForTimeout(3300);
    await openHub(); await startSlideshow(1); await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false');
    report.checks.push('Shuffle preserves the current portrait and visits all five exactly once before a nonrepeating next cycle; restoring order preserves current, favorites update, explicit playback advances at the selected real interval, pause stops, Back unmounts and close/reopen never leaves autoplay running');

    stage = 'modal-failure-and-stale-retry';
    await app.evaluate(({ ipcMain }) => {
      globalThis.__playgroundLibraryGetHandler = ipcMain._invokeHandlers.get('library-get');
      if (typeof globalThis.__playgroundLibraryGetHandler !== 'function') throw new Error('Owned IPC failure capture is unavailable');
      ipcMain.removeHandler('library-get');
      ipcMain.handle('library-get', () => ({ ok: false, error: { code: 'IO_ERROR', message: 'Owned temporary handoff failure' } }));
    });
    await page.locator('#slideshowDetails').click(); await expect(page.locator('#playgroundDialog')).toBeVisible();
    await expectSlide(1); await expect(page.locator('#detailDialog')).toBeHidden();
    await expect(page.locator('#playgroundFeedback')).toBeVisible(); await expect(page.locator('#playgroundFeedback')).toHaveAttribute('role', 'alert');
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('library-get'); ipcMain.handle('library-get', globalThis.__playgroundLibraryGetHandler);
      delete globalThis.__playgroundLibraryGetHandler;
    });
    allowedStaleMedia = await page.locator('#slideshowImage').getAttribute('src');
    const retryLatest = await writeLatest(1, 'slideshow-retry');
    const refreshed = await page.evaluate(() => window.portraitStudio.libraryList()); expect(refreshed.ok).toBe(true);
    await page.locator('#slideshowNext').click(); await expectSlide(2); await page.locator('#slideshowImage').evaluate(image => image.decode());
    await page.locator('#slideshowPrevious').click(); await expectSlide(1);
    await expect(page.locator('#slideshow')).toHaveAttribute('data-image-state', 'error');
    await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false'); await expect(page.locator('#slideshowRetry')).toBeVisible();
    await page.locator('#slideshowRetry').click(); await expectSlide(1); await expect(page.locator('#slideshow')).toHaveAttribute('data-image-state', 'loaded');
    expect(await page.locator('#slideshowImage').getAttribute('src')).not.toBe(allowedStaleMedia);
    expect(report.expectedMediaFailures).toHaveLength(1); allowedStaleMedia = null;
    await page.locator('#slideshowPromptToggle').click(); await expect(page.locator('#slideshowPrompt')).toHaveText(retryLatest.zh);
    report.checks.push('An owned library-get failure remains inside the open modal with visible alert feedback and preserves its current image; a declared external revision change produces exactly one stale-image 404, stops playback, and Retry fetches the latest same-ID image/prompt while preserving the launched sequence');

    stage = 'slideshow-latest-handoff';
    const slideLatest = await writeLatest(1, 'slideshow-detail'); await page.locator('#slideshowDetails').click();
    await expect(page.locator('#playgroundDialog')).toBeHidden(); await expect(page.locator('#detailIndex')).toHaveText('001');
    await expect(page.locator('#detailPrompt')).toHaveText(slideLatest.zh); await page.locator('#closeDialog').click();
    await openHub(); await startSlideshow(1); await writeLatest(1, 'slideshow-remix');
    await page.locator('#slideshowCreativeLab').click(); await expect(page.locator('#playgroundDialog')).toBeHidden();
    await expect(page.locator('#creativeLabDialog')).toBeVisible(); await expect(page.locator('[data-lab-source]')).toHaveCount(1);
    await expect(page.locator('[data-lab-source="1"]')).toContainText('最新外部中文 slideshow-remix。'); await page.locator('#closeCreativeLab').click();
    report.checks.push('Slideshow detail and creative remix close the session and read latest authoritative bilingual prompts after owned external edits');

    stage = 'library-isolation';
    await openHub(); await startSlideshow(1); await closePlayground(); await switchLibrary(rootOne, 1);
    await openHub(); await expect(page.locator('#playDuel')).toBeDisabled(); await startSlideshow(1);
    await expect(page.locator('#slideshowPosition')).toContainText('1 / 1'); await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false');
    await expect(page.locator('#slideshowFavorite')).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('#slideshowImage')).toHaveAttribute('src', /portrait-media:/u);
    await closePlayground(); await switchLibrary(rootEmpty, 0); await expect(page.locator('#openPlayground')).toBeDisabled();
    await switchLibrary(rootA, 5); await openHub(); await expect(page.locator('#playDuel')).toBeEnabled(); await startSlideshow(1);
    await expect(page.locator('#slideshowPosition')).toContainText('1 / 5'); await expect(page.locator('#slideshow')).toHaveAttribute('data-playing', 'false'); await closePlayground();
    report.checks.push('Switching owned libraries after closing discards prior games/playback and builds a new pool; overlapping IDs do not inherit favorite state, one image disables duel and empty libraries disable entry');

    stage = 'preservation';
    expect(await fingerprint(rootA)).toEqual(authoritativeA); expect(await fingerprint(rootOne)).toEqual(originalOne); expect(await fingerprint(rootEmpty)).toEqual(originalEmpty);
    const finalA = await fingerprint(rootA);
    for (const [relative, hash] of Object.entries(originalA)) if (relative !== '.portrait-studio/library.json') expect(finalA[relative]).toBe(hash);
    expect(await fingerprint(createdA.source)).toEqual(sourceA); expect(await fingerprint(createdOne.source)).toEqual(sourceOne);
    expect(report.errors).toEqual([]); expect(report.requests).toEqual([]);
    report.checks.push('All Playground operations preserve fixture indices except the declared external-writer edits, preserve all original and imported image/source bytes, touch no real library/OS clipboard/Trash/external opener, emit no renderer or unexpected media errors and send no HTTP or service requests');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.stage = stage; report.failure = error.stack ?? error.message;
    if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, 'playground-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'playground-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, requests: report.requests, report: path.join(output, 'playground-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
