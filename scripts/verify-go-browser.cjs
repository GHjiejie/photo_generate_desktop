'use strict';

const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const output = path.resolve(__dirname, '../.verification');
const reportPath = path.join(output, 'go-browser-verification.json');
const origin = 'http://127.0.0.1:5173';
const hash = value => createHash('sha256').update(value).digest('hex');
const messages = require('../src/ui-messages.json');
const report = {
  status: 'running', production: false, nativeElectron: false, ubuntuDeployed: false,
  scope: 'Actual Chrome React app -> actual Vite readonly proxy -> Go API on this Mac with a private 100-item library copy. No API or bridge mock. This does not establish production or Ubuntu deployment.',
  apiMocked: false, bridgeMocked: false, osClipboardReadOrWritten: false,
  copyEvidence: 'Production browser bridge invokes navigator.clipboard.writeText; the test captures that argument in memory without touching the OS clipboard.',
  density: 'Existing five-column dense mode selected using the grid-density button; no style changes.',
  checks: [], geometry: [], details: [], copies: [], requests: [], screenshots: [], errors: []
};
let browser, stage = 'start';
function save() { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify({ ...report, stage }, null, 2) + '\n'); }

async function main() {
  try {
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/__preview/api/')) report.requests.push({
        method: response.request().method(), route: url.pathname + url.search, status: response.status(),
        mime: response.headers()['content-type'], declaredBytes: response.headers()['content-length'] ?? null
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem('portraitStudio.uiLanguage', 'zh');
      localStorage.setItem('portraitStudio.theme', 'dark');
      localStorage.setItem('portraitStudio.sidebarCollapsed', 'false');
      window.__goBrowserCopies = [];
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__goBrowserCopies.push(text); } });
    });
    stage = 'real-library-load';
    await page.goto(origin + '/');
    await expect(page.locator('.portrait-card')).toHaveCount(100, { timeout: 30000 });
    const result = await page.evaluate(() => window.portraitStudio.libraryList());
    expect(result.ok).toBe(true);
    const snapshot = result.data;
    expect(snapshot.remote).toBe(true); expect(snapshot.writable).toBe(false); expect(snapshot.items.length).toBe(100); expect(snapshot.revision).toBe(3);
    expect(snapshot.items.map(item => item.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_value, index) => index + 1));
    expect(snapshot.items.every(item => item.image_url === `/__preview/api/images/${item.id}?revision=${item.revision}`)).toBe(true);
    const newItem = snapshot.items.find(item => item.id === 51);
    expect(newItem).toBeTruthy(); expect(newItem.prompts.zh.length).toBeGreaterThan(100); expect(newItem.prompts.en.length).toBeGreaterThan(100);
    report.library = { root: snapshot.root, count: snapshot.items.length, revision: snapshot.revision, writable: snapshot.writable, remote: snapshot.remote,
      newItem: { id: newItem.id, label: newItem.label, sourceId: newItem.sourceMetadata?.id, promptLengths: { zh: newItem.prompts.zh.length, en: newItem.prompts.en.length },
        promptSHA256: { zh: hash(Buffer.from(newItem.prompts.zh)), en: hash(Buffer.from(newItem.prompts.en)) } } };
    report.checks.push('Actual readonly remote snapshot has exactly 100 IDs 1-100 at revision 3, including new item 51 and complete bilingual prompts');

    stage = 'browser-permission-menu';
    await page.locator('#libraryMenuToggle').click();
    for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) await expect(page.locator(selector)).toBeDisabled();
    await expect(page.locator('#libraryRefresh')).toBeEnabled();
    await expect(page.locator('#libraryRoot')).toHaveText(messages.zh['sidebar.serverLocation']);
    await page.locator('#libraryMenuPanel').press('Escape');
    report.checks.push('Real browser bridge keeps import, connection configuration and batch write actions disabled; refresh remains available');

    await page.locator('#gridToggle').click();
    await expect(page.locator('#gallery')).toHaveClass(/dense/);
    stage = 'decode-all-real-images';
    const decoded = [];
    for (let index = 0; index < 100; index += 1) {
      const image = page.locator('.portrait-card .portrait-image').nth(index);
      decoded.push(await image.evaluate(async node => {
        node.closest('.portrait-card').scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(resolve));
        await node.decode();
        return { id: Number(node.closest('.portrait-card').dataset.id), complete: node.complete, width: node.naturalWidth, height: node.naturalHeight,
          imageRoute: new URL(node.currentSrc).pathname + new URL(node.currentSrc).search };
      }));
      if ((index + 1) % 25 === 0) { report.decodeProgress = index + 1; save(); console.log(JSON.stringify({ stage, decoded: index + 1, total: 100 })); }
    }
    expect(decoded.every(image => image.complete && image.width > 0 && image.height > 0)).toBe(true);
    expect(new Set(decoded.map(image => image.id)).size).toBe(100);
    report.decodedImages = decoded;
    report.checks.push('All 100 actual gallery images decoded after scrolling each card into view, with nonzero dimensions and fixed image routes');

    stage = 'search-new-source-label';
    const search = newItem.sourceMetadata?.label || newItem.label;
    await page.locator('#searchInput').fill(search);
    await expect(page.locator('.portrait-card[data-id="51"]')).toBeVisible();
    const matchingIds = await page.locator('.portrait-card').evaluateAll(nodes => nodes.map(node => Number(node.dataset.id)));
    expect(matchingIds).toContain(51);
    report.search = { query: search, source: newItem.sourceMetadata?.label ? 'sourceMetadata.label' : 'item.label', matchingIds };
    await page.locator('#searchInput').fill('');
    await expect(page.locator('.portrait-card')).toHaveCount(100);
    report.checks.push('Searching the actual new source label returns item 51; clearing the search restores all 100 cards');

    async function language(locale) {
      await page.locator('#settingsToggle').click();
      await page.locator(`#uiLanguage button[data-language="${locale}"]`).click();
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
      await page.locator('#settingsPanel').press('Escape');
    }
    async function screenshot(name) {
      const destination = path.join(output, `go-browser-${name}.png`);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: destination, scale: 'css', animations: 'disabled' });
      report.screenshots.push(destination);
    }
    for (const viewport of [{ width: 1440, height: 920 }, { width: 2048, height: 1280 }]) {
      await page.setViewportSize(viewport);
      for (const locale of ['zh', 'en']) {
        stage = `geometry-${locale}-${viewport.width}x${viewport.height}`;
        await language(locale);
        await page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0; });
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.evaluate(() => {
          const rect = selector => { const value = document.querySelector(selector).getBoundingClientRect(); return { left: value.left, top: value.top, width: value.width, height: value.height, centerY: value.top + value.height / 2 }; };
          return { sidebar: rect('.sidebar'), main: rect('.main-content'), search: rect('.search-box'), logo: rect('.brand-mark'), brandText: rect('.brand-text'), toggle: rect('#sidebarToggle'),
            columns: getComputedStyle(document.querySelector('#gallery')).gridTemplateColumns.split(' ').length,
            viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth };
        });
        expect(geometry.sidebar.width).toBe(250); expect(geometry.columns).toBe(5);
        expect(Math.abs(geometry.sidebar.width + geometry.main.width - viewport.width)).toBeLessThanOrEqual(0.05);
        for (const key of ['search', 'logo', 'brandText', 'toggle']) expect(Math.abs(geometry[key].centerY - 47)).toBeLessThanOrEqual(0.05);
        expect(geometry.documentWidth).toBeLessThanOrEqual(viewport.width);
        report.geometry.push({ viewport, locale, ...geometry });
        await screenshot(`gallery-${locale}-${viewport.width}x${viewport.height}`);

        stage = `detail-${locale}-${viewport.width}x${viewport.height}`;
        await page.locator('.portrait-card[data-id="51"]').click();
        await expect(page.locator('#detailDialog')).toBeVisible();
        const detailImage = await page.locator('#detailImage').evaluate(async node => { await node.decode(); return { complete: node.complete, width: node.naturalWidth, height: node.naturalHeight }; });
        expect(detailImage.complete).toBe(true); expect(detailImage.width).toBe(1024); expect(detailImage.height).toBe(1536);
        expect(await page.locator('#detailPrompt').textContent()).toBe(newItem.prompts[locale]);
        await expect(page.locator('#detailEdit')).toHaveCount(0); await expect(page.locator('#detailDelete')).toHaveCount(0);
        const rect = await page.locator('#detailDialog').boundingBox();
        expect(Math.abs(rect.width - 1030)).toBeLessThanOrEqual(0.05); expect(Math.abs(rect.height - 696.3203125)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(rect.x - (viewport.width - 1030) / 2)).toBeLessThanOrEqual(0.05);
        expect(Math.abs(rect.y - (viewport.height - 696.3203125) / 2)).toBeLessThanOrEqual(0.05);
        const button = await page.locator('#detailCopy').boundingBox(); expect(button.y + button.height).toBeLessThanOrEqual(rect.y + rect.height);
        const promptScrolling = await page.locator('#detailPrompt').evaluate(node => { const wrapper = node.closest('.prompt-box'); return { overflowY: getComputedStyle(wrapper).overflowY, scrollHeight: wrapper.scrollHeight, clientHeight: wrapper.clientHeight }; });
        expect(promptScrolling.overflowY).toBe('auto');
        await screenshot(`detail-${locale}-${viewport.width}x${viewport.height}`);
        const before = await page.evaluate(() => window.__goBrowserCopies.length);
        await page.locator('#detailCopy').click();
        await expect.poll(() => page.evaluate(() => window.__goBrowserCopies.length)).toBe(before + 1);
        const copied = await page.evaluate(() => window.__goBrowserCopies.at(-1));
        expect(copied).toBe(newItem.prompts[locale]);
        report.copies.push({ locale, viewport, itemId: 51, length: copied.length, sha256: hash(Buffer.from(copied)), exactFullPromptMatch: true });
        report.details.push({ locale, viewport, itemId: 51, rect, detailImage, promptScrolling, fullPromptMatchesActualAPI: true });
        await page.locator('#closeDialog').click(); await expect(page.locator('#detailDialog')).not.toBeVisible();
        save();
      }
    }
    report.checks.push('Four fixed-size/language views retain 250px sidebar, five columns and search/logo/text/toggle center Y=47');
    report.checks.push('Actual new item 51 detail shows exact full zh/en API prompts, decoded 1024x1536 image and 1030x696.3203125 centered modal');
    report.checks.push('Four production detail copy actions send the exact full API prompt to navigator.clipboard without touching the OS clipboard');
    expect(report.requests.every(request => request.method === 'GET' && request.status === 200)).toBe(true);
    const imageIds = new Set(report.requests.filter(request => request.route.startsWith('/__preview/api/images/')).map(request => Number(/images\/(\d+)/.exec(request.route)[1])));
    expect(imageIds.size).toBe(100);
    expect(report.requests.some(request => request.route === '/__preview/api/portraits/51')).toBe(true);
    report.network = { actualAPIResponses: report.requests.length, uniqueImageIds: imageIds.size, allGET: true, allStatus200: true };
    expect(report.errors).toEqual([]);
    stage = 'completed'; report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = { message: error.message, stage };
    throw error;
  } finally {
    save(); await browser?.close();
    console.log(JSON.stringify({ status: report.status, stage, count: report.library?.count, decodedImages: report.decodedImages?.length, checks: report.checks.length, screenshots: report.screenshots.length, report: reportPath, errors: report.errors }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
