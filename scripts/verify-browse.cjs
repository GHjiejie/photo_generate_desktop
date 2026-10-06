'use strict';

// Production Electron/React/preload/local IPC, with an owned temporary library
// and profile. Browsing never changes the fixture's index or image bytes.
const { _electron: electron, expect } = require('@playwright/test');
const { PNG } = require('pngjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LocalLibrary } = require('../local-library.cjs');
const { prepareBatchImport } = require('../batch-import.cjs');
const messages = require('../src/ui-messages.json');

const project = path.resolve(__dirname, '..');
const output = path.join(project, '.verification');
const viewKey = 'portraitStudio.galleryView.v1';
const report = {
  status: 'running', checks: [], errors: [], screenshots: [],
  scope: 'Actual Electron UI, preload and local IPC with five temporary images and an isolated profile; no real library, OS clipboard, external image opener or system Trash changes.'
};
let app, temporary;

async function fixture(root, source) {
  const library = new LocalLibrary();
  let state = await library.open(root);
  for (const [id, label, filename] of [[3, 'Zulu', '001-natural-window.png'], [18, 'Beta', '003-korean-fresh.png'], [105, 'Alpha', '033-autumn-forest.png']]) {
    state = await library.create({ id, label, type: 'photo', prompts: {
      en: `Subject: browse fixture local ${id}.\nStyle: natural light; keep all prompt details.`,
      zh: `主体：浏览测试图片 local ${id}。\n风格：自然光，保留全部提示词。`
    }, expectedVersion: state.revision }, path.join(project, 'assets/images', filename));
  }
  const records = [
    { id: 18, label: 'Original eighteen', label_en: 'Alpha', label_cn: '安静', filename: '018-source.png', prompt_en: 'Subject: browse fixture import-original-eighteen.\nKeep this complete source prompt.', prompt_cn: '主体：browse fixture 原始十八。\n保留完整来源提示词。' },
    { id: 3, label: 'Original three', label_en: 'Alpha', label_cn: '雪山', filename: '003-source.png', prompt_en: 'Subject: browse fixture import-original-three.\nKeep this complete source prompt.', prompt_cn: '主体：browse fixture 原始三。\n保留完整来源提示词。' }
  ];
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(records, null, 2) + '\n');
  await fs.copyFile(path.join(project, 'assets/images/012-italian-luxury.png'), path.join(source, records[0].filename));
  await fs.copyFile(path.join(project, 'assets/images/013-scandinavian-minimal.png'), path.join(source, records[1].filename));
  const plan = await prepareBatchImport({ imageDirectory: source, manifestPath, type: 'photo', validateImage: bytes => PNG.sync.read(bytes).width > 0 });
  state = await library.importBatch(plan, { collisionPolicy: 'allocate-new', confirmed: true, expectedVersion: state.revision });
  expect(state.items.map(item => item.id)).toEqual([3, 18, 105, 106, 107]);
  expect(state.items.find(item => item.id === 106).sourceImport.sourceId).toBe(3);
  expect(state.items.find(item => item.id === 107).sourceImport.sourceId).toBe(18);
  return state;
}

async function bytes(root, state) {
  return Promise.all([fs.readFile(path.join(root, '.portrait-studio/library.json')), ...state.items.map(item => fs.readFile(path.join(root, item.imageRel)))]);
}

(async () => {
  try {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-browse-ui-')));
    const root = path.join(temporary, 'library'), source = path.join(temporary, 'source'), profile = path.join(temporary, 'profile');
    await Promise.all([root, source, profile, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const initial = await fixture(root, source), before = await bytes(root, initial);
    const sourceBefore = await Promise.all((await fs.readdir(source)).sort().map(filename => fs.readFile(path.join(source, filename))));
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: root, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const allIds = [3, 18, 105, 106, 107], descendingIds = [107, 106, 105, 18, 3], englishNameIds = [105, 106, 107, 18, 3], chineseNameIds = [107, 106, 105, 18, 3];
    const ids = page => page.locator('.portrait-card').evaluateAll(cards => cards.map(card => Number(card.dataset.id)));
    const order = (page, expected) => expect.poll(() => ids(page)).toEqual(expected);
    const decode = page => page.locator('.portrait-image').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    async function launch() {
      app = await electron.launch({ executablePath: require('electron'), args: [project], env });
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 920 });
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('response', response => { if (response.url().startsWith('portrait-media:') && response.status() >= 400) report.errors.push(`Image response ${response.status()}: ${response.url()}`); });
      await app.evaluate(({ clipboard, shell }) => {
        clipboard.writeText = () => { throw new Error('Browsing unexpectedly wrote to clipboard'); };
        shell.openPath = () => { throw new Error('Browsing unexpectedly opened an external image'); };
        shell.trashItem = () => { throw new Error('Browsing unexpectedly touched system Trash'); };
      });
      await expect(page.locator('.portrait-card')).toHaveCount(5);
      await decode(page);
      return page;
    }
    async function screenshot(page, filename) {
      await page.screenshot({ path: path.join(output, filename) });
      report.screenshots.push(filename);
    }
    async function appearance(page, language, theme) {
      await page.locator('#settingsToggle').click();
      await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
      await page.locator(`#themeControl button[data-theme="${theme}"]`).click();
      await page.locator('#settingsPanel').press('Escape');
      await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    async function detail(page, id) {
      await page.locator(`.portrait-card[data-id="${id}"]`).click();
      await expect(page.locator('#detailDialog')).toBeVisible();
      await expect(page.locator('#detailIndex')).toHaveText(String(id).padStart(3, '0'));
    }
    async function position(page, current, total) {
      await expect(page.locator('#detailPosition')).toContainText(`${current} / ${total}`);
    }
    async function tags(page, id, names, count) {
      await detail(page, id);
      await page.locator('#tagInput').fill(names);
      await page.locator('#tagInput').press('Enter');
      await expect(page.locator('.tag-chip')).toHaveCount(count);
      await page.locator('#closeDialog').click();
    }
    async function preferences(page, expected) {
      await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), viewKey)).toEqual(expected);
    }
    async function fittedGeometry(page) {
      const viewport = await page.locator('#viewerViewport').boundingBox();
      const image = await page.locator('#viewerImage').boundingBox();
      expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0);
      expect(image.x).toBeGreaterThanOrEqual(viewport.x - 1); expect(image.y).toBeGreaterThanOrEqual(viewport.y - 1);
      expect(image.x + image.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1);
      expect(image.y + image.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
      const natural = await page.locator('#viewerImage').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }));
      expect(image.width / image.height).toBeCloseTo(natural.width / natural.height, 4);
    }
    let page = await launch();
    await order(page, allIds);
    await expect(page.locator('#gallerySort')).toHaveValue('default');
    await expect(page.locator('#gridToggle')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#gallerySort').selectOption('number-desc');
    await order(page, descendingIds);
    await page.locator('#gallerySort').selectOption('name-asc');
    await order(page, chineseNameIds);
    await appearance(page, 'en', 'light');
    await order(page, englishNameIds);
    await page.locator('#gridToggle').click();
    await expect(page.locator('#gallery')).toHaveClass(/\bdense\b/);
    await preferences(page, { sort: 'name-asc', dense: true });
    await app.close(); app = null; page = await launch();
    await order(page, englishNameIds);
    await expect(page.locator('#gallerySort')).toHaveValue('name-asc');
    await expect(page.locator('#gridToggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    report.checks.push('Default/descending/name sorting uses local image IDs, localized display labels and deterministic duplicate-label order; sort and density survive an actual Electron restart');

    for (const damaged of ['{broken-json', JSON.stringify({ sort: 'unknown', dense: 'true' })]) {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: viewKey, value: damaged });
      await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(5);
      await order(page, allIds);
      await expect(page.locator('#gallerySort')).toHaveValue('default');
      await expect(page.locator('#gridToggle')).toHaveAttribute('aria-pressed', 'false');
    }
    await page.locator('#gallerySort').selectOption('number-desc');
    await page.locator('#gridToggle').click();
    await preferences(page, { sort: 'number-desc', dense: true });
    await page.evaluate(key => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Owned test quota failure', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }, viewKey);
    await page.locator('#gallerySort').selectOption('name-asc'); await order(page, englishNameIds);
    await page.locator('#gridToggle').click(); await expect(page.locator('#gridToggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toastMessage')).toHaveText(messages.en['browse.sessionOnly']);
    await expect(page.locator('#toast')).toHaveAttribute('role', 'alert');
    await preferences(page, { sort: 'number-desc', dense: true });
    await page.reload(); await order(page, descendingIds);
    await expect(page.locator('#gridToggle')).toHaveAttribute('aria-pressed', 'true');
    report.checks.push('Damaged JSON and invalid preference fields recover safely; failed preference writes preserve live sort/density, notify the user and retain the last saved preference');

    await tags(page, 3, 'film, travel', 2); await tags(page, 18, 'film', 1);
    await tags(page, 105, 'travel', 1); await tags(page, 106, 'travel', 1);
    for (const id of [3, 18, 106]) await page.locator(`.portrait-card[data-id="${id}"] .favorite-button`).click();
    await appearance(page, 'zh', 'dark');
    await page.locator('#searchInput').fill('fixture');
    await page.locator('#tagFilter').selectOption('film');
    await page.locator('#favoriteImages').click(); await order(page, [18, 3]);
    await expect(page.locator('#clearSearchFilter')).toBeVisible();
    await expect(page.locator('#clearBrowseTagFilter')).toBeVisible();
    await expect(page.locator('#clearFavoriteFilter')).toBeVisible();
    await screenshot(page, 'browse-filters-zh-dark.png');
    await page.locator('#clearSearchFilter').click();
    await expect(page.locator('#searchInput')).toHaveValue(''); await order(page, [18, 3]);
    await expect(page.locator('#tagFilter')).toHaveValue('film');
    await expect(page.locator('#clearFavoriteFilter')).toBeVisible();
    await page.locator('#searchInput').fill('Alpha'); await order(page, []);
    await page.locator('#clearBrowseTagFilter').click(); await order(page, [106]);
    await expect(page.locator('#tagFilter')).toHaveValue('');
    await expect(page.locator('#searchInput')).toHaveValue('Alpha');
    await page.locator('#clearFavoriteFilter').click(); await order(page, [107, 106, 105]);
    await expect(page.locator('#searchInput')).toHaveValue('Alpha');
    await page.locator('#clearSearch').click();
    await expect(page.locator('#searchInput')).toHaveValue('');
    await expect(page.locator('#searchInput')).toBeFocused(); await order(page, descendingIds);
    await page.locator('#searchInput').fill('fixture'); await page.locator('#tagFilter').selectOption('film');
    await page.locator('#favoriteImages').click(); await order(page, [18, 3]);
    await page.locator('#resetBrowseFilters').click(); await order(page, descendingIds);
    await expect(page.locator('#searchInput')).toHaveValue(''); await expect(page.locator('#tagFilter')).toHaveValue('');
    await expect(page.locator('#clearSearchFilter')).toHaveCount(0); await expect(page.locator('#clearBrowseTagFilter')).toHaveCount(0); await expect(page.locator('#clearFavoriteFilter')).toHaveCount(0);
    await page.locator('#searchInput').fill('no-fixture-has-this-query'); await order(page, []);
    await page.locator('#resetBrowseFilters').click(); await order(page, descendingIds);
    report.checks.push('Visible search/tag/favorite summary chips independently clear their own filter; header clear restores search focus; reset recovers combined filters and empty search results while retaining sort/density');

    await page.locator('#searchInput').fill('fixture');
    await page.locator('#beginBatchDelete').click();
    await page.locator('.portrait-card[data-id="105"]').click();
    await expect(page.locator('#selectedCount')).toHaveText(messages.zh['gallery.selectedCount'].replace('{count}', '1'));
    await page.locator('#searchInput').focus(); await page.keyboard.press('Escape');
    await expect(page.locator('#beginBatchDelete')).toBeVisible();
    await expect(page.locator('.select-checkbox')).toHaveCount(0);
    await expect(page.locator('#detailDialog')).toBeHidden();
    await page.locator('#beginBatchDelete').click();
    await expect(page.locator('#selectedCount')).toHaveText(messages.zh['gallery.selectedCount'].replace('{count}', '0'));
    await page.locator('#exitSelection').click();
    await page.locator('#searchInput').fill('');
    report.checks.push('Escape exits batch selection and clears selected IDs while the search field has a query and focus');

    await page.locator('#tagFilter').selectOption('film'); await page.locator('#favoriteImages').click();
    await order(page, [18, 3]); await detail(page, 18); await position(page, 1, 2);
    await expect(page.locator('#detailImage')).toHaveCSS('object-fit', 'contain');
    await page.locator('.detail-image-actions .favorite-button').click(); await order(page, [3]);
    await expect(page.locator('#detailIndex')).toHaveText('018');
    await expect(page.locator('#detailPosition')).toHaveText(messages.zh['browse.positionOutside']);
    await expect(page.locator('#detailPrevious')).toBeEnabled(); await expect(page.locator('#detailNext')).toBeEnabled();
    await page.locator('#detailNext').click(); await expect(page.locator('#detailIndex')).toHaveText('003'); await position(page, 1, 1);
    await expect(page.locator('#detailPrevious')).toBeDisabled(); await expect(page.locator('#detailNext')).toBeDisabled();
    await page.locator('#detailViewer').click(); await expect(page.locator('#imageViewer')).toBeVisible();
    await expect(page.locator('#viewerZoomIn')).toBeEnabled(); await fittedGeometry(page);
    await screenshot(page, 'browse-viewer-zh-dark.png');
    await page.locator('#viewerClose').click(); await page.locator('#closeDialog').click();
    await page.locator('#resetBrowseFilters').click(); await order(page, descendingIds);
    await page.locator('.portrait-card[data-id="18"] .favorite-button').click();
    report.checks.push('Removing the current favorite from filtered detail reports outside-results position and lets Next reach the sole remaining result; detail contains the full image and the Chinese/dark viewer fits entirely within its viewport');

    await appearance(page, 'en', 'light');
    await page.locator('#gallerySort').selectOption('name-asc'); await page.locator('#searchInput').fill('Alpha');
    await order(page, [105, 106, 107]); await detail(page, 106); await position(page, 2, 3);
    await expect(page.locator('#detailTitle')).toHaveText('Alpha');
    await page.locator('#detailPrevious').click(); await expect(page.locator('#detailIndex')).toHaveText('105'); await position(page, 1, 3);
    await page.locator('#detailPrevious').click(); await expect(page.locator('#detailIndex')).toHaveText('107'); await position(page, 3, 3);
    await page.locator('#detailNext').click(); await expect(page.locator('#detailIndex')).toHaveText('105'); await position(page, 1, 3);
    await page.locator('#detailNext').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#detailIndex')).toHaveText('106'); await position(page, 2, 3);
    await page.locator('#tagInput').fill('editable draft'); await page.locator('#tagInput').press('ArrowLeft'); await page.locator('#tagInput').press('ArrowRight');
    await expect(page.locator('#detailIndex')).toHaveText('106'); await expect(page.locator('#tagInput')).toHaveValue('editable draft');
    await page.locator('#tagInput').fill('');
    await screenshot(page, 'browse-detail-navigation-en-light.png');
    await page.locator('#closeDialog').click();
    await page.locator('#searchInput').fill('import-original-three'); await order(page, [106]);
    await detail(page, 106); await position(page, 1, 1);
    await expect(page.locator('#detailPrevious')).toBeDisabled(); await expect(page.locator('#detailNext')).toBeDisabled();
    await page.locator('#closeDialog').click();
    await page.locator('#clearSearch').click(); await order(page, englishNameIds);
    await detail(page, 106); await position(page, 2, 5);
    report.checks.push('Detail counter reports sorted/filtered position separately from local image number; buttons/arrow keys navigate and wrap the visible sequence, single-result navigation disables, and editing tag text does not navigate');

    await page.locator('#detailViewer').click(); await expect(page.locator('#imageViewer')).toBeVisible();
    const viewport = page.locator('#viewerViewport'), image = page.locator('#viewerImage');
    await image.evaluate(image => image.decode());
    await expect(page.locator('#viewerZoomIn')).toBeEnabled();
    const fitted = Number(await viewport.getAttribute('data-scale'));
    expect(fitted).toBeGreaterThan(0); expect(fitted).toBeLessThan(1);
    expect(await image.evaluate(image => getComputedStyle(image).objectFit)).toBe('contain');
    await fittedGeometry(page);
    await page.locator('#viewerZoomIn').click();
    await expect.poll(async () => Number(await viewport.getAttribute('data-scale'))).toBeGreaterThan(fitted);
    await page.locator('#viewerZoomOut').click();
    await expect.poll(async () => Number(await viewport.getAttribute('data-scale'))).toBeCloseTo(fitted, 4);
    await page.locator('#viewerActualSize').click(); await expect(viewport).toHaveAttribute('data-scale', '1');
    const size = await image.evaluate(image => ({ naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height }));
    expect(size.width).toBeCloseTo(size.naturalWidth, 2); expect(size.height).toBeCloseTo(size.naturalHeight, 2);
    await expect(viewport).toHaveAttribute('data-can-pan', 'true');
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 90, { steps: 5 }); await page.mouse.up();
    const offset = { x: Number(await viewport.getAttribute('data-offset-x')), y: Number(await viewport.getAttribute('data-offset-y')) };
    expect(Math.abs(offset.x) + Math.abs(offset.y)).toBeGreaterThan(0);
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(Math.max(0, (size.width - box.width) / 2) + 2);
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(Math.max(0, (size.height - box.height) / 2) + 2);
    await page.keyboard.press('ArrowLeft'); await expect(page.locator('#detailIndex')).toHaveText('106');
    await page.locator('#viewerFit').click();
    await expect.poll(async () => Number(await viewport.getAttribute('data-scale'))).toBeCloseTo(fitted, 4);
    await expect(viewport).toHaveAttribute('data-offset-x', '0'); await expect(viewport).toHaveAttribute('data-offset-y', '0');
    await screenshot(page, 'browse-viewer-en-light.png');
    await page.locator('#viewerActualSize').click(); await page.keyboard.press('Escape');
    await expect(page.locator('#imageViewer')).toBeHidden(); await expect(page.locator('#detailDialog')).toBeVisible();
    await expect(page.locator('#detailIndex')).toHaveText('106'); await position(page, 2, 5);
    await expect(page.locator('#detailViewer')).toBeFocused();
    await page.locator('#detailViewer').click(); await expect(page.locator('#imageViewer')).toBeVisible();
    await expect.poll(async () => Number(await viewport.getAttribute('data-scale'))).toBeCloseTo(fitted, 4);
    await expect(viewport).toHaveAttribute('data-offset-x', '0'); await expect(viewport).toHaveAttribute('data-offset-y', '0');
    await viewport.dblclick(); await expect(viewport).toHaveAttribute('data-scale', '1');
    await viewport.dblclick(); await expect.poll(async () => Number(await viewport.getAttribute('data-scale'))).toBeCloseTo(fitted, 4);
    await page.locator('#viewerClose').click(); await expect(page.locator('#imageViewer')).toBeHidden();
    await expect(page.locator('#detailDialog')).toBeVisible(); await page.locator('#closeDialog').click();
    report.checks.push('In-app viewer fits the complete image, zooms in/out, displays native pixels at 100%, pans within overflow bounds, resets pan on fit, isolates arrows, restores detail focus on Escape and reopens at fit; double-click toggles actual size/fit');

    expect(await bytes(root, initial)).toEqual(before);
    expect(await Promise.all((await fs.readdir(source)).sort().map(filename => fs.readFile(path.join(source, filename))))).toEqual(sourceBefore);
    expect(report.errors).toEqual([]);
    report.checks.push('All browsing, preferences, tags/favorites and viewer operations leave the owned library index, five image files and imported source bytes unchanged; no renderer/media errors');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.message;
    if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, 'browse-failure.png') }).catch(() => {});
    throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'browse-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, report: path.join(output, 'browse-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
