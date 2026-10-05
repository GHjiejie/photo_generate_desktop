'use strict';

// Real production React, Electron preload and local IPC, using only owned
// temporary libraries/profile. The chooser and Trash target only test files.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LocalLibrary } = require('../local-library.cjs');
const messages = require('../src/ui-messages.json');

const project = path.resolve(__dirname, '..');
const output = path.join(project, '.verification');
const report = { status: 'running', checks: [], errors: [], scope: 'Production Electron UI with isolated libraries and profile; no real library, clipboard, picker or system Trash changes.' };
let app, temporary;

async function fixture(root, entries) {
  const library = new LocalLibrary();
  let snapshot = await library.open(root);
  for (const [id, label, image] of entries) {
    snapshot = await library.create({ id, label, type: 'photo', prompts: { en: `Complete English inspiration fixture ${id}`, zh: `完整中文灵感测试提示词 ${id}` }, expectedVersion: snapshot.revision }, path.join(project, 'assets/images', image));
  }
  return snapshot;
}

async function preservedBytes(root, snapshot) {
  return Promise.all([
    fs.readFile(path.join(root, '.portrait-studio/library.json')),
    ...snapshot.items.map(item => fs.readFile(path.join(root, 'assets/images', item.image)))
  ]);
}

(async () => {
  try {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-inspiration-ui-')));
    const rootA = path.join(temporary, 'library-a'), rootB = path.join(temporary, 'library-b');
    const profile = path.join(temporary, 'profile'), trash = path.join(temporary, 'trash');
    await Promise.all([rootA, rootB, profile, trash, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const snapshotA = await fixture(rootA, [
      [1, 'Alpha one', '001-natural-window.png'], [2, 'Alpha two', '003-korean-fresh.png'],
      [3, 'Beta three', '012-italian-luxury.png'], [4, 'Beta four', '013-scandinavian-minimal.png'],
      [5, 'Gamma five', '033-autumn-forest.png']
    ]);
    const snapshotB = await fixture(rootB, [[1, 'Other one', '031-rainy-night.png'], [2, 'Other two', '043-renaissance.png']]);
    const beforeA = await preservedBytes(rootA, snapshotA), beforeB = await preservedBytes(rootB, snapshotB);
    const keyA = `portraitStudio.favorites.v1.${JSON.stringify(['local', '', rootA])}`;
    const keyB = `portraitStudio.favorites.v1.${JSON.stringify(['local', '', rootB])}`;
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: rootA, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    async function launch() {
      app = await electron.launch({ executablePath: require('electron'), args: [project], env });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 920 });
      page.on('pageerror', error => report.errors.push(error.message));
      await expect(page.locator('.portrait-card')).toHaveCount(5);
      await page.evaluate(() => Promise.all([...document.querySelectorAll('.portrait-image')].map(image => image.decode())));
      return page;
    }
    async function switchLibrary(page, root, count) {
      await page.evaluate(() => Promise.all([...document.querySelectorAll('.portrait-image')].map(image => image.decode())));
      await app.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = async (_window, options) => {
          if (!options.properties.includes('openDirectory')) throw new Error('Unexpected test picker');
          return { canceled: false, filePaths: [root] };
        };
      }, root);
      await page.locator('#libraryMenuToggle').click();
      await page.locator('#libraryConfigure').click();
      await expect(page.locator('.portrait-card')).toHaveCount(count);
      await expect(page.locator('#allImages')).toHaveAttribute('aria-pressed', 'true');
    }
    const favorite = (page, id) => page.locator(`.portrait-card[data-id="${id}"] .favorite-button`);
    const visibleIds = page => page.locator('.portrait-card').evaluateAll(cards => cards.map(card => Number(card.dataset.id)));
    const detailId = page => page.locator('#detailIndex').innerText().then(text => Number(text.split('/')[0].trim()));

    let page = await launch();
    await page.evaluate(() => {
      localStorage.setItem('portraitStudio.uiLanguage', 'zh');
      localStorage.setItem('portraitStudio.theme', 'dark');
      localStorage.setItem('portraitStudio.sidebarCollapsed', 'false');
    });
    await page.reload();
    await expect(page.locator('#favoriteCount')).toHaveText('0');
    await favorite(page, 1).click();
    await expect(page.locator('#detailDialog')).toBeHidden();
    await favorite(page, 3).focus(); await page.keyboard.press('Space');
    await expect(favorite(page, 3)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    await page.locator('#favoriteImages').click();
    expect(await visibleIds(page)).toEqual([1, 3]);
    await page.screenshot({ path: path.join(output, 'inspiration-favorites-zh-dark.png') });
    await page.locator('#searchInput').fill('Beta');
    expect(await visibleIds(page)).toEqual([3]);
    await page.locator('#randomInspiration').click();
    await expect(page.locator('#detailDialog')).toBeVisible();
    expect(await detailId(page)).toBe(3);
    await page.locator('.detail-image-actions .favorite-button').click();
    await expect(page.locator('#favoriteCount')).toHaveText('1');
    await expect(page.locator('#detailRandom')).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    expect(await detailId(page)).toBe(3);
    await page.locator('#closeDialog').click();
    await expect(page.locator('#emptyTitle')).toHaveText(messages.zh['favorites.noResults']);
    await expect(page.locator('#randomInspiration')).toBeDisabled();
    await page.locator('#showAllImages').click();
    expect(await visibleIds(page)).toEqual([3, 4]);
    report.checks.push('Card/keyboard and detail favorites synchronize; search intersects favorites, empty states recover and single-result random browsing works');

    await page.locator('#searchInput').fill('Alpha');
    await page.locator('#randomInspiration').click();
    await expect(page.locator('#detailDialog')).toBeVisible();
    await expect.poll(() => detailId(page)).toBeGreaterThan(0);
    let previous = await detailId(page);
    for (let step = 0; step < 8; step++) {
      await page.locator('#detailRandom').click();
      await expect.poll(() => detailId(page)).not.toBe(previous);
      const current = await detailId(page);
      expect([1, 2]).toContain(current);
      await expect(page.locator('#detailPrompt')).toHaveText(`完整中文灵感测试提示词 ${current}`);
      previous = current;
    }
    if (previous !== 2) {
      await page.locator('#detailRandom').click();
      await expect.poll(() => detailId(page)).toBe(2);
    }
    await expect(page.locator('.detail-image-actions .favorite-button')).toHaveAttribute('data-favorite-id', '2');
    await page.locator('.detail-image-actions .favorite-button').click();
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    await page.screenshot({ path: path.join(output, 'inspiration-detail-zh-dark.png') });
    await page.locator('#closeDialog').click();
    await page.locator('#searchInput').fill('');
    await page.reload();
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    await expect(favorite(page, 1)).toHaveAttribute('aria-pressed', 'true');
    await expect(favorite(page, 2)).toHaveAttribute('aria-pressed', 'true');
    report.checks.push('Random browsing stays inside current search and avoids consecutive repeats; full prompts and saved favorites survive reload');

    await switchLibrary(page, rootB, 2);
    await expect(page.locator('#favoriteCount')).toHaveText('0');
    await favorite(page, 2).click();
    await expect(page.locator('#favoriteCount')).toHaveText('1');
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyB)).toEqual([2]);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyA)).toEqual([1, 2]);
    await page.locator('#favoriteImages').click();
    await switchLibrary(page, rootA, 5);
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    await expect(favorite(page, 1)).toHaveAttribute('aria-pressed', 'true');
    expect(await preservedBytes(rootA, snapshotA)).toEqual(beforeA);
    expect(await preservedBytes(rootB, snapshotB)).toEqual(beforeB);
    report.checks.push('Native library switching isolates overlapping IDs, resets the view and preserves all image/index bytes while favorites change');

    await page.locator('#favoriteImages').click();
    await page.locator('#beginBatchDelete').click();
    await expect(page.locator('.gallery .favorite-button')).toHaveCount(0);
    await expect(page.locator('#randomInspiration')).toBeDisabled();
    await page.locator('#selectVisible').click();
    await expect(page.locator('#selectedCount')).toHaveText('已选 2 张');
    await page.locator('#allImages').click();
    await expect(page.locator('#selectedCount')).toHaveText('已选 2 张');
    await page.keyboard.press('Escape');
    await expect(page.locator('.select-checkbox')).toHaveCount(0);
    await expect(page.locator('#randomInspiration')).toBeEnabled();
    report.checks.push('Favorites compose with batch selection; selection retains IDs across filters and disables random/card stars until Escape');

    await page.locator('#settingsToggle').click();
    await page.locator('#uiLanguage button[data-language="en"]').click();
    await page.locator('#themeControl button[data-theme="light"]').click();
    await page.locator('#settingsPanel').press('Escape');
    await expect(page.locator('#favoriteImages')).toHaveAttribute('aria-label', messages.en['favorites.view']);
    await expect(favorite(page, 1)).toHaveAttribute('aria-label', 'Unfavorite Alpha one');
    await expect(page.locator('#randomInspiration')).toHaveText(messages.en['favorites.random']);
    await page.locator('#sidebarToggle').click();
    await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true');
    await page.locator('#favoriteImages').focus(); await page.keyboard.press('Enter');
    expect(await visibleIds(page)).toEqual([1, 2]);
    await page.screenshot({ path: path.join(output, 'inspiration-favorites-en-light-collapsed.png') });
    await app.close(); app = null;
    page = await launch();
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#randomInspiration')).toHaveText(messages.en['favorites.random']);
    report.checks.push('Both languages, light/dark themes and collapsed keyboard navigation work; favorites persist across an actual Electron restart');

    await page.evaluate(key => localStorage.setItem(key, '{broken-json'), keyA);
    await page.reload();
    await expect(page.locator('#favoriteCount')).toHaveText('0');
    await page.locator('#favoriteImages').click();
    await expect(page.locator('#emptyTitle')).toHaveText(messages.en['favorites.emptyTitle']);
    await page.locator('#showAllImages').click();
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify([1, 1, '2', 0, null, 999999, 2])), keyA);
    await page.reload();
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyA)).toEqual([1, 2]);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('portraitStudio.favorites.')) throw new DOMException('Test storage quota', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await favorite(page, 3).click();
    await expect(page.locator('#favoriteCount')).toHaveText('3');
    await expect(page.locator('#toastMessage')).toHaveText(messages.en['favorites.sessionOnly']);
    await expect(page.locator('#toast')).toHaveAttribute('role', 'alert');
    await page.reload();
    await expect(page.locator('#favoriteCount')).toHaveText('2');
    report.checks.push('Malformed/invalid stored IDs recover safely; storage failure preserves session favorites and reports that persistence failed');

    const writer = new LocalLibrary({ trashItem: filename => {
      if (!filename.startsWith(path.join(rootA, 'assets/images') + path.sep)) throw new Error('Unowned test file');
      return fs.rename(filename, path.join(trash, path.basename(filename)));
    } });
    await page.evaluate(() => Promise.all([...document.querySelectorAll('.portrait-image')].map(image => image.decode())));
    await expect.poll(async () => {
      try {
        const current = await writer.open(rootA), removed = current.items.find(item => item.id === 1);
        await writer.remove({ id: 1, expectedVersion: current.revision, expectedRevision: removed.revision, confirmed: true });
        return 'removed';
      } catch (error) {
        if (error.code !== 'LIBRARY_BUSY') throw error;
        return 'busy';
      }
    }, { timeout: 10000, intervals: [100, 250, 500] }).toBe('removed');
    await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryRefresh').click();
    await expect(page.locator('.portrait-card')).toHaveCount(4);
    await expect(page.locator('#favoriteCount')).toHaveText('1');
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyA)).toEqual([2]);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyB)).toEqual([2]);
    await page.locator('#favoriteImages').click();
    expect(await visibleIds(page)).toEqual([2]);
    await favorite(page, 2).click();
    await expect(page.locator('#emptyTitle')).toHaveText(messages.en['favorites.emptyTitle']);
    await expect(page.locator('#randomInspiration')).toBeDisabled();
    report.checks.push('Successful refresh prunes a removed favorite only in its own library; unfavoriting the final image shows the correct empty state');
    expect(report.errors).toEqual([]);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.message;
    if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, 'inspiration-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'inspiration-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, report: path.join(output, 'inspiration-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
