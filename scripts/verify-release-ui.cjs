'use strict';

// Packaged UI checks use only a complete private copy of the real library.
// The test captures copy IPC arguments in its own main process; no OS clipboard
// is read or written, and no production code or persistent library is changed.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const project = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const executable = process.env.PORTRAIT_STUDIO_EXECUTABLE;
if (!executable || !path.isAbsolute(executable)) throw new Error('Set PORTRAIT_STUDIO_EXECUTABLE to the packaged executable absolute path');
const name = `package-${version}-ui`;
const output = path.join(project, '.verification');
const supplement = process.argv.includes('--detail-image-only');
const reportPath = path.join(output, `${name}-${supplement ? 'image-ready-supplement' : 'verification'}.json`);
const realRoot = fs.realpathSync(require('../assets/default-library.json').root);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const libraryRoot = path.join(temporary, 'copied-photo-repo');
const profile = path.join(temporary, 'profile');
const indexRelative = path.join('.portrait-studio', 'library.json');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const messages = require('../src/ui-messages.json');
const baseline = JSON.parse(fs.readFileSync(path.join(output, 'i18n-cn-modal-baseline.json')));
const records = JSON.parse(fs.readFileSync(path.join(realRoot, indexRelative))).items;
const first = records[0];
const report = {
  status: 'running', version, executable, temporary, profile, realRoot, libraryRoot,
  scope: 'Packaged desktop renderer, external image decoding, preferences, bilingual full-prompt IPC arguments, fixed detail size and security; native mutation transactions are verified separately',
  osClipboardReadOrWritten: false,
  copyEvidence: 'Production React copy actions and fixed preload IPC run; this isolated app main-process copy-text handler captures arguments instead of writing the OS clipboard',
  checks: [], geometry: [], modals: [], copies: [], transitions: [], screenshots: [], security: [], errors: [],
};
let app, page, stage = 'copy-isolated-library';

function snapshot(directory) {
  const rows = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (child === path.join('.portrait-studio', 'lock.json')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Library symlink is not permitted in this verification: ${child}`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) { const bytes = fs.readFileSync(path.join(directory, child)); rows[child] = { size: bytes.length, sha256: sha(bytes) }; }
      else throw new Error(`Unsupported library entry: ${child}`);
    }
  }
  visit(''); return rows;
}
function save() { fs.writeFileSync(reportPath, `${JSON.stringify({ ...report, stage }, null, 2)}\n`); }
const originalSnapshot = snapshot(realRoot);
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(profile);
fs.cpSync(realRoot, libraryRoot, { recursive: true, errorOnExist: true, force: false, filter: source => path.relative(realRoot, source) !== path.join('.portrait-studio', 'lock.json') });
expect(snapshot(libraryRoot)).toEqual(originalSnapshot);
report.realSnapshotBefore = originalSnapshot;
process.on('uncaughtExceptionMonitor', error => { report.status = 'failed'; report.failure = error.stack; save(); });

async function launch() {
  stage = 'launch-packaged-app';
  app = await electron.launch({ executablePath: executable, args: [], env: { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile, PORTRAIT_STUDIO_LIBRARY_DIR: libraryRoot } });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push({ type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.errors.push({ type: 'console', text: message.text(), location: message.location() }); });
  await expect(page.locator('.portrait-card')).toHaveCount(records.length);
  await app.evaluate(({ ipcMain }) => {
    globalThis.__releaseUiCopies = [];
    ipcMain.removeHandler('copy-text');
    ipcMain.handle('copy-text', (_event, value) => { globalThis.__releaseUiCopies.push(value); return true; });
  });
  const security = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences();
    return { pid: process.pid, packaged: app.isPackaged, version: app.getVersion(), userData: app.getPath('userData'), appPath: app.getAppPath(), resourcesPath: process.resourcesPath, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity };
  });
  expect(security.packaged).toBe(true); expect(security.version).toBe(version); expect(security.userData).toBe(profile);
  expect(security.contextIsolation).toBe(true); expect(security.nodeIntegration).toBe(false); expect(security.sandbox).toBe(true); expect(security.webSecurity).toBe(true);
  expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
  expect(await page.evaluate(() => window.portraitStudio.mode)).toBe(undefined);
  expect(await page.evaluate(() => Object.keys(window.portraitStudio).sort())).toEqual(['cancelBatch', 'chooseBatchDirectory', 'chooseImage', 'chooseLibrary', 'commitBatch', 'copyText', 'createPortrait', 'deletePortrait', 'libraryGet', 'libraryList', 'openImage', 'previewBatch', 'releaseImage', 'setUILanguage', 'updatePortrait']);
  security.csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(security.csp).toContain("script-src 'self'"); expect(security.csp).toContain("connect-src 'none'"); expect(security.csp).not.toContain('unsafe-eval');
  report.security.push(security);
  await verifyMenu();
}
async function closeOwned() { if (app) { await app.close(); app = null; page = null; } }
async function setSize(width, height) {
  // macOS constrains physical windows to the display work area. Match the
  // existing renderer baselines by emulating CSS viewport size in this actual
  // packaged Electron renderer while recording the native window separately.
  await page.setViewportSize({ width, height });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width, height });
  report.nativeWindowViewportEvidence = await app.evaluate(({ BrowserWindow }) => ({ nativeBounds: BrowserWindow.getAllWindows()[0].getBounds(), rendererViewportEmulatedForFixedBaseline: true }));
}
async function verifyMenu() {
  await page.locator('#libraryMenuToggle').click();
  for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch', '#libraryRefresh']) await expect(page.locator(selector)).toBeEnabled();
  await expect(page.locator('#libraryRoot')).toHaveText(fs.realpathSync(libraryRoot));
  const actual = await page.evaluate(async () => window.portraitStudio.libraryList());
  expect(actual.ok).toBe(true); expect(actual.data.writable).toBe(true); expect(actual.data.items.length).toBe(records.length);
  expect(actual.data.items.every(item => item.image_url.startsWith('portrait-media://asset/'))).toBe(true);
  await page.locator('#libraryMenuPanel').press('Escape');
  report.checks.push({ desktopMenuEnabled: true, libraryWritable: true, actualCards: records.length, externalMediaProtocol: true });
}
async function settings(theme, locale) {
  await page.locator('#settingsToggle').click(); await expect(page.locator('#settingsPanel')).toBeVisible();
  await page.locator(`#themeControl button[data-theme="${theme}"]`).click();
  await page.locator(`#uiLanguage button[data-language="${locale}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
  await expect(page.locator('#settingsToggle')).toHaveAttribute('aria-label', messages[locale]['settings.open']);
  await expect(page.locator('#searchInput')).toHaveAttribute('placeholder', messages[locale]['header.search']);
  await page.locator('#settingsPanel').press('Escape'); await expect(page.locator('#settingsToggle')).toBeFocused();
}
async function collapsed(value) {
  if ((await page.locator('.sidebar').getAttribute('data-collapsed')) !== String(value)) await page.locator('#sidebarToggle').click();
  await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', String(value));
  await expect.poll(() => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width)).toBe(value ? 80 : 250);
  await page.evaluate(async () => { const animations = document.querySelector('.sidebar').getAnimations({ subtree: true }); await Promise.all(animations.map(animation => animation.finished.catch(() => {}))); });
}
async function geometry(theme, locale, width, height, folded) {
  const measurements = await page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, centerY: r.top + r.height / 2, right: r.right, bottom: r.bottom }; };
    return { sidebar: rect('.sidebar'), main: rect('.main-content'), toggle: rect('#sidebarToggle'), search: rect('.search-box'), brandMark: rect('.brand-mark'), brandText: rect('.brand-text'), collection: rect('.collection-card'), documentWidth: document.documentElement.scrollWidth };
  });
  expect(measurements.sidebar.width).toBe(folded ? 80 : 250);
  expect(Math.abs(measurements.sidebar.width + measurements.main.width - width)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(measurements.toggle.centerY - 47)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(measurements.search.centerY - 47)).toBeLessThanOrEqual(0.05);
  if (!folded) {
    expect(Math.abs(measurements.brandMark.centerY - 47)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(measurements.brandText.centerY - 47)).toBeLessThanOrEqual(0.05);
    expect(measurements.collection.top).toBe(108);
  }
  expect(measurements.documentWidth).toBeLessThanOrEqual(width);
  await expect(page.locator('.portrait-card')).toHaveCount(records.length);
  report.geometry.push({ theme, locale, viewport: { width, height }, collapsed: folded, ...measurements });
}
async function capture(filename) {
  const target = path.join(output, `${name}-${filename}.png`);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: target, scale: 'css', animations: 'disabled' }); report.screenshots.push(target);
}
async function copy(action, locale, entrypoint) {
  const before = await app.evaluate(() => globalThis.__releaseUiCopies.length);
  await action();
  await expect.poll(() => app.evaluate(() => globalThis.__releaseUiCopies.length)).toBe(before + 1);
  const text = await app.evaluate(() => globalThis.__releaseUiCopies.at(-1));
  expect(text).toBe(first.prompts[locale]);
  report.copies.push({ locale, entrypoint, length: text.length, sha256: sha(Buffer.from(text)), fullPromptMatchesIndex: true });
}
async function modal(theme, locale, width, height) {
  await page.locator(`.portrait-card[data-id="${first.id}"]`).click(); await expect(page.locator('#detailDialog')).toBeVisible();
  const detailImage = await page.locator('#detailImage').evaluate(async image => { await image.decode(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, src: image.currentSrc }; });
  expect(detailImage.complete).toBe(true); expect(detailImage.width).toBe(1122); expect(detailImage.height).toBe(1402);
  await expect(page.locator('#detailPrompt')).toHaveText(first.prompts[locale]);
  await expect(page.locator('#detailEdit')).toBeEnabled(); await expect(page.locator('#detailDelete')).toBeEnabled();
  const rect = await page.locator('#detailDialog').boundingBox();
  const old = baseline.measurements.find(row => row.id === 1 && row.viewport.width === width && row.viewport.height === height).nodes['#detailDialog'].rect;
  const deltas = { left: rect.x - old.left, top: rect.y - old.top, width: rect.width - old.width, height: rect.height - old.height };
  for (const delta of Object.values(deltas)) expect(Math.abs(delta)).toBeLessThanOrEqual(0.05);
  const button = await page.locator('#detailCopy').boundingBox(); expect(button.y + button.height).toBeLessThanOrEqual(rect.y + rect.height);
  const scrolling = await page.locator('#detailPrompt').evaluate(node => { const wrapper = node.closest('.prompt-box'); return { overflowY: getComputedStyle(wrapper).overflowY, scrollHeight: wrapper.scrollHeight, clientHeight: wrapper.clientHeight }; });
  expect(scrolling.overflowY).toBe('auto');
  if (width === 1440 && theme === 'dark') await copy(() => page.locator('#detailCopy').click(), locale, 'detail-button');
  report.modals.push({ theme, locale, viewport: { width, height }, rect, baselineDeltas: deltas, promptScrolling: scrolling, detailImage, desktopEditDeleteEnabled: true });
  if (width === 1440 && theme === 'dark') await capture(`detail-${theme}-${locale}-${width}x${height}`);
  await page.locator('#closeDialog').click(); await expect(page.locator('#detailDialog')).not.toBeVisible();
}
async function transition() {
  await collapsed(false);
  const samples = await page.evaluate(async () => {
    const node = document.querySelector('.sidebar'), main = document.querySelector('.main-content'), button = document.querySelector('#sidebarToggle');
    const frames = [], start = performance.now(); button.click();
    while (performance.now() - start < 280) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const r = node.getBoundingClientRect(), m = main.getBoundingClientRect();
      frames.push({ elapsed: performance.now() - start, sidebar: r.width, main: m.width, sum: r.width + m.width, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth });
    }
    return { duration: getComputedStyle(node).transitionDuration, frames };
  });
  expect(samples.duration).toContain('0.2s'); expect(samples.frames.some(frame => frame.sidebar > 80.1 && frame.sidebar < 249.9)).toBe(true);
  for (const frame of samples.frames) { expect(Math.abs(frame.sum - frame.viewport)).toBeLessThanOrEqual(0.05); expect(frame.documentWidth).toBeLessThanOrEqual(frame.viewport); }
  report.transitions.push(samples);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await collapsed(false);
  const reduced = await page.locator('.sidebar').evaluate(node => ({ duration: getComputedStyle(node).transitionDuration, activeAnimations: node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length }));
  expect(reduced.duration).toBe('0s'); expect(reduced.activeAnimations).toBe(0); report.transitions.push({ reducedMotion: true, ...reduced });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

(async () => {
  try {
    await launch(); stage = 'verify-images-and-preferences';
    if (supplement) {
      report.scope = 'Supplemental English detail screenshot with explicit image decode and two paint-frame waits; earlier complete UI verification remains unchanged';
      await settings('dark', 'en'); await setSize(1440, 920); await collapsed(false); await modal('dark', 'en', 1440, 920);
      await closeOwned(); report.realSnapshotAfter = snapshot(realRoot); expect(report.realSnapshotAfter).toEqual(originalSnapshot); expect(snapshot(libraryRoot)).toEqual(originalSnapshot); expect(report.errors).toEqual([]);
      report.status = 'passed'; stage = 'supplement-complete'; save(); console.log(JSON.stringify({ status: 'passed', scope: report.scope, report: reportPath, screenshots: report.screenshots, ownedPids: report.security.map(row => row.pid) })); return;
    }
    const decoded = await page.locator('.portrait-image').evaluateAll(async images => {
      return Promise.all(images.map(async image => { image.loading = 'eager'; await image.decode(); return { src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight }; }));
    });
    expect(decoded).toHaveLength(records.length); expect(decoded.every(image => image.width === 1122 && image.height === 1402)).toBe(true);
    report.checks.push({ allExternalImagesDecoded: decoded.length, dimensions: '1122x1402', imageSample: decoded[0] });
    for (const theme of ['dark', 'light']) for (const locale of ['zh', 'en']) {
      await settings(theme, locale);
      for (const [width, height] of [[1440, 920], [1080, 720]]) {
        await setSize(width, height);
        for (const folded of [false, true]) { await collapsed(folded); await geometry(theme, locale, width, height, folded); }
        await collapsed(false); await modal(theme, locale, width, height);
      }
      await setSize(1440, 920);
      if (theme === 'dark') await copy(() => page.locator(`.portrait-card[data-id="${first.id}"] .copy-button`).click(), locale, 'gallery-button');
      if (theme === 'dark' && locale === 'zh' || theme === 'light' && locale === 'en') { await collapsed(theme === 'light'); await capture(`gallery-${theme}-${locale}-1440x920`); }
    }
    await transition();
    await settings('light', 'en'); await collapsed(true);
    const prefs = await page.evaluate(() => ({ language: localStorage.getItem('portraitStudio.uiLanguage'), theme: localStorage.getItem('portraitStudio.theme'), collapsed: localStorage.getItem('portraitStudio.sidebarCollapsed') }));
    expect(prefs).toEqual({ language: 'en', theme: 'light', collapsed: 'true' });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(records.length);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true');
    report.checks.push({ reloadPreferencesPersisted: true, preferences: prefs });
    await closeOwned(); await launch(); stage = 'verify-restart-preferences';
    await expect(page.locator('html')).toHaveAttribute('lang', 'en'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'light'); await expect(page.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true');
    report.checks.push({ restartPreferencesPersisted: true });
    await closeOwned();
    report.realSnapshotAfter = snapshot(realRoot); expect(report.realSnapshotAfter).toEqual(originalSnapshot); expect(snapshot(libraryRoot)).toEqual(originalSnapshot);
    expect(report.errors).toEqual([]);
    report.status = 'passed'; stage = 'complete'; save();
    console.log(JSON.stringify({ status: report.status, report: reportPath, geometryCases: report.geometry.length, fixedModals: report.modals.length, fullPromptCopies: report.copies.length, screenshots: report.screenshots, ownedPids: report.security.map(row => row.pid), osClipboardReadOrWritten: false }));
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack; save(); console.error(error); process.exitCode = 1;
  } finally {
    await closeOwned().catch(error => { report.errors.push({ type: 'cleanup', message: error.message }); save(); });
  }
})();
