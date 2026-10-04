const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.verification');
const url = process.env.PORTRAIT_STUDIO_PREVIEW_URL || 'http://127.0.0.1:5173/';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const indexPath = path.join(root, 'photo_repo/.portrait-studio/library.json');
const before = fs.readFileSync(indexPath);
const index = JSON.parse(before);
const item = index.items.find(item => item.id === 1);
const baseline = JSON.parse(fs.readFileSync(path.join(output, 'i18n-cn-modal-baseline.json')));
const messages = JSON.parse(fs.readFileSync(path.join(root, 'src/ui-messages.json')));
const reportPath = path.join(output, 'i18n-single-language-verification.json');
const copies = [], measurements = [], screenshots = [], errors = [], requests = [], checks = [];
let browser, page, bridge;
const report = status => ({ status, url, browser: browser?.version(), bridge, checks, measurements, copies, screenshots, errors, requests, indexSha256Before: sha(before), indexSha256After: sha(fs.readFileSync(indexPath)), osClipboardReadOrWritten: false, clipboardEvidence: 'Only isolated page navigator.clipboard.writeText parameters were captured', nativeCRUDTested: false });

async function cleanHeader() {
  const file = path.join(output, 'i18n-clean-header-verification.json');
  const priorPath = path.join(output, 'i18n-single-language-verification.json');
  const priorBytes = fs.readFileSync(priorPath);
  expect(JSON.parse(priorBytes).status).toBe('passed');
  const rows = [], frames = [], issues = [];
  let instance;
  try {
    instance = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await instance.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    const view = await context.newPage();
    view.on('pageerror', error => issues.push(error.message));
    view.on('console', message => { if (message.type() === 'error') issues.push({ text: message.text(), location: message.location() }); });
    await view.goto(url);
    await expect(view.locator('.portrait-card')).toHaveCount(50);
    const adapter = await view.evaluate(() => ({ mode: window.portraitStudio.mode, keys: Object.keys(window.portraitStudio).sort() }));
    expect(adapter.mode).toBe('browser-preview');
    expect(adapter.keys).toEqual(['copyText', 'libraryGet', 'libraryList', 'mode', 'openImage']);
    for (const locale of ['zh', 'en']) {
      await view.locator(`#uiLanguage button[data-language="${locale}"]`).click();
      await expect(view.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
      await expect(view.locator('.side-nav .nav-item > span:nth-child(2)')).toHaveText(messages[locale]['sidebar.all']);
      await expect(view.locator('.collection-title')).toHaveText(messages[locale]['sidebar.title']);
      await expect(view.locator('#searchInput')).toHaveAttribute('placeholder', messages[locale]['header.search']);
      await expect(view.locator('#libraryCreate')).toHaveText(messages[locale]['sidebar.import']);
      for (const [width, height] of [[1440, 920], [1080, 720]]) {
        await view.setViewportSize({ width, height });
        await expect(view.locator('.portrait-card')).toHaveCount(50);
        await expect(view.locator('.title-block,.topbar .crumb,.topbar h1,.topbar p,.toolbar-note,.sidebar-tip,.card-prompt-hint,#libraryNotice,#detailUILanguage,.prompt-follow')).toHaveCount(0);
        await expect(view.locator('#uiLanguage')).toHaveCount(1);
        await expect(view.locator('.prompt-language')).toHaveCount(1);
        await expect(view.locator('.toolbar > *')).toHaveCount(1);
        const geometry = await view.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom, middleY: r.top + r.height / 2 }; };
          const selectors = ['.collection-kicker', '.collection-title', '.side-nav', '#libraryCreate', '#libraryConfigure', '#libraryBatch', '#libraryLocationHelp', '#libraryStatus'];
          return { header: rect('.topbar'), search: rect('.search-actions'), language: rect('#uiLanguage'), viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, systemText: selectors.map(selector => ({ selector, text: document.querySelector(selector).textContent })) };
        });
        expect(geometry.search.right).toBeLessThan(geometry.language.left);
        expect(Math.abs(geometry.search.middleY - geometry.language.middleY)).toBeLessThanOrEqual(1);
        expect(geometry.search.left).toBeGreaterThanOrEqual(geometry.header.left);
        expect(geometry.language.right).toBeLessThanOrEqual(geometry.header.right);
        expect(geometry.documentWidth).toBeLessThanOrEqual(width);
        for (const label of geometry.systemText) expect(label.text).not.toMatch(/portrait|肖像/i);
        rows.push({ locale, ...geometry });
        if (width === 1440) {
          await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
          await view.mouse.move(10, 10);
          const frame = path.join(output, `i18n-clean-header-gallery-${locale}-1440x920.png`);
          await view.screenshot({ path: frame, scale: 'css', animations: 'disabled' }); frames.push(frame);
        }
      }
    }
    expect(fs.readFileSync(priorPath)).toEqual(priorBytes);
    expect(fs.readFileSync(indexPath)).toEqual(before);
    expect(issues).toEqual([]);
    fs.writeFileSync(file, `${JSON.stringify({ status: 'passed', scope: 'Incremental clean header and generic image-library wording; prior copy and modal verification was not repeated', priorVerification: priorPath, priorVerificationSha256: sha(priorBytes), priorVerificationUnchanged: true, browser: instance.version(), url, actualCards: 50, adapter, measurements: rows, screenshots: frames, osClipboardReadOrWritten: false, nativeAppStarted: false, indexSha256Before: sha(before), indexSha256After: sha(fs.readFileSync(indexPath)), errors: issues }, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', scope: 'clean-header incremental', report: file, measurements: rows.length, screenshots: frames }));
  } catch (error) {
    fs.writeFileSync(file, `${JSON.stringify({ status: 'failed', scope: 'clean-header incremental', measurements: rows, screenshots: frames, errors: issues, error: error.stack }, null, 2)}\n`); throw error;
  } finally { if (instance) await instance.close(); }
}

async function settingsTheme() {
  const file = path.join(output, 'i18n-settings-theme-verification.json');
  const priorPath = path.join(output, 'i18n-single-language-verification.json');
  const priorBytes = fs.readFileSync(priorPath);
  expect(JSON.parse(priorBytes).status).toBe('passed');
  const rows = [], frames = [], captured = [], contrastRows = [], issues = [], apiRequests = [];
  let instance;
  const makeReport = status => ({ status, scope: 'Incremental settings, themes, sticky search and two full-prompt copy checks; previous eight-copy verification was not repeated', priorVerification: priorPath, priorVerificationSha256: sha(priorBytes), priorVerificationUnchanged: fs.readFileSync(priorPath).equals(priorBytes), url, browser: instance?.version(), actualCards: 50, measurements: rows, contrasts: contrastRows, screenshots: frames, copies: captured, osClipboardReadOrWritten: false, clipboardEvidence: 'Only isolated page navigator.clipboard.writeText parameters were captured', editorEvidence: 'Computed styles of existing closed editor controls only; the read-only preview cannot open an editor', nativeAppStarted: false, nativeCRUDTested: false, indexSha256Before: sha(before), indexSha256After: sha(fs.readFileSync(indexPath)), requests: apiRequests, errors: issues });
  try {
    instance = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await instance.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      window.__settingsCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__settingsCopies.push(text); } } });
    });
    const view = await context.newPage();
    view.on('pageerror', error => issues.push(error.message));
    view.on('console', message => { if (message.type() === 'error') issues.push({ text: message.text(), location: message.location() }); });
    view.on('request', request => { if (new URL(request.url()).pathname.startsWith('/__preview/api/')) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    await view.goto(url);
    await expect(view.locator('.portrait-card')).toHaveCount(50);
    await expect(view.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await view.evaluate(() => localStorage.getItem('portraitStudio.theme'))).toBe(null);
    const adapter = await view.evaluate(() => ({ mode: window.portraitStudio.mode, keys: Object.keys(window.portraitStudio).sort() }));
    expect(adapter.mode).toBe('browser-preview'); expect(adapter.keys).toEqual(['copyText', 'libraryGet', 'libraryList', 'mode', 'openImage']);
    for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) await expect(view.locator(selector)).toBeDisabled();
    async function settings() {
      if (!await view.locator('#settingsPanel').count()) await view.locator('#settingsToggle').click();
      await expect(view.locator('#settingsPanel')).toBeVisible();
      await expect(view.locator('#uiLanguage')).toHaveCount(1);
      await expect(view.locator('#settingsPanel #uiLanguage')).toHaveCount(1);
      await expect(view.locator('.topbar #uiLanguage')).toHaveCount(0);
      await expect(view.locator('#settingsToggle')).toHaveAttribute('aria-expanded', 'true');
    }
    async function closeSettings() { await view.locator('#settingsPanel').press('Escape'); await expect(view.locator('#settingsPanel')).toHaveCount(0); await expect(view.locator('#settingsToggle')).toBeFocused(); }
    async function contrast(selectors, theme, locale, contextName) {
      const result = await view.evaluate(selectors => {
        const rgba = value => {
          const match = /^rgba?\(([^)]+)\)$/.exec(value);
          if (!match) throw new Error(`Unsupported computed color ${value}`);
          const parts = match[1].split(',').map(Number); return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        };
        const over = (front, back) => [0, 1, 2].map(i => front[i] * front[3] + back[i] * (1 - front[3])).concat(1);
        const background = node => {
          const stack = []; for (let current = node; current; current = current.parentElement) stack.unshift(rgba(getComputedStyle(current).backgroundColor));
          return stack.reduce((back, front) => over(front, back), [255, 255, 255, 1]);
        };
        const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
        return selectors.map(selector => {
          const node = document.querySelector(selector); if (!node) return { selector, absent: true };
          const css = getComputedStyle(node), bg = background(node), fg = over(rgba(css.color), bg), a = luminance(fg), b = luminance(bg);
          return { selector, foreground: css.color, effectiveBackground: bg.slice(0, 3), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), fontSize: css.fontSize, disabled: Boolean(node.disabled), visible: node.getClientRects().length > 0 };
        });
      }, selectors);
      for (const row of result) { expect(row.absent).not.toBe(true); if (!row.disabled) expect(row.ratio, `${theme}/${locale} ${row.selector} text contrast`).toBeGreaterThanOrEqual(4.5); }
      contrastRows.push({ theme, locale, context: contextName, computedOnly: contextName === 'closed-editor', nodes: result });
    }
    await settings();
    await expect(view.locator('#uiLanguage button[data-language="zh"]')).toBeFocused();
    await closeSettings();
    await settings(); await view.locator('#resultCount').click();
    await expect(view.locator('#settingsPanel')).toHaveCount(0);
    rows.push({ phase: 'settings keyboard and outside dismissal', escapeRestoresTriggerFocus: true, outsideClosesPanel: true, outsideActiveElement: await view.evaluate(() => ({ tag: document.activeElement.tagName, id: document.activeElement.id })) });
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') {
        await settings(); await view.locator('#themeControl button[data-theme="light"]').click();
        await expect(view.locator('html')).toHaveAttribute('data-theme', 'light');
        expect(await view.evaluate(() => localStorage.getItem('portraitStudio.theme'))).toBe('light');
        await view.reload(); await expect(view.locator('.portrait-card')).toHaveCount(50); await expect(view.locator('html')).toHaveAttribute('data-theme', 'light');
      }
      for (const locale of ['zh', 'en']) {
        await settings(); await view.locator(`#uiLanguage button[data-language="${locale}"]`).click();
        await expect(view.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
        await expect(view.locator('#settingsToggle')).toHaveAttribute('aria-label', messages[locale]['settings.open']);
        await expect(view.locator(`#themeControl button[data-theme="${theme}"]`)).toHaveAttribute('aria-pressed', 'true');
        await contrast(['#settingsTitle', '#uiLanguage button[aria-pressed="true"]', '#themeControl button[aria-pressed="true"]'], theme, locale, 'settings');
        await closeSettings();
        await contrast(['#portraitLabel', '#portraitPromptEn', '#portraitPromptZh', '#portraitCancel', '#portraitSave'], theme, locale, 'closed-editor');
        await expect(view.locator('#portraitEditor')).not.toBeVisible(); await expect(view.locator('#portraitSave')).toBeDisabled();
        for (const [width, height] of [[1440, 920], [1080, 720]]) {
          await view.setViewportSize({ width, height });
          await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
          const searchBefore = await view.locator('.search-actions').boundingBox();
          await view.locator('.main-content').evaluate(node => { node.scrollTop = 400; });
          await expect.poll(() => view.locator('.main-content').evaluate(node => node.scrollTop)).toBe(400);
          const searchAfter = await view.locator('.search-actions').boundingBox();
          for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(searchBefore[key] - searchAfter[key]), `${theme}/${locale} sticky search ${key}`).toBeLessThanOrEqual(0.05);
          const scrolling = await view.evaluate(() => {
            const main = document.querySelector('.main-content'), bar = document.querySelector('.topbar'), search = document.querySelector('.search-actions'), r = search.getBoundingClientRect();
            const underSearch = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { scrollTop: main.scrollTop, scrollHeight: main.scrollHeight, clientHeight: main.clientHeight, overflowY: getComputedStyle(main).overflowY, headerPosition: getComputedStyle(bar).position, searchVisibleAboveCards: Boolean(underSearch?.closest('.search-actions')), documentWidth: document.documentElement.scrollWidth };
          });
          expect(scrolling.headerPosition).toBe('sticky'); expect(scrolling.overflowY).toBe('auto'); expect(scrolling.searchVisibleAboveCards).toBe(true); expect(scrolling.documentWidth).toBeLessThanOrEqual(width);
          await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
          await view.locator('.portrait-card[data-id="1"]').click(); await expect(view.locator('#detailDialog')).toBeVisible();
          await expect.poll(() => view.locator('#detailPrompt').textContent()).toBe(item.prompts[locale]);
          const modal = await view.locator('#detailDialog').boundingBox();
          const old = baseline.measurements.find(row => row.id === 1 && row.viewport.width === width && row.viewport.height === height).nodes['#detailDialog'].rect;
          const deltas = { top: modal.y - old.top, left: modal.x - old.left, width: modal.width - old.width, height: modal.height - old.height };
          for (const delta of Object.values(deltas)) expect(Math.abs(delta)).toBeLessThanOrEqual(0.05);
          const copyBox = await view.locator('#detailCopy').boundingBox(); expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(modal.y + modal.height);
          await contrast(['#detailTitle', '#detailPrompt', '#detailCopy', '#detailOpen'], theme, locale, 'detail');
          if (theme === 'dark' && width === 1440) {
            const count = await view.evaluate(() => window.__settingsCopies.length); await view.locator('#detailCopy').click();
            await expect.poll(() => view.evaluate(() => window.__settingsCopies.length)).toBe(count + 1);
            const value = await view.evaluate(() => window.__settingsCopies.at(-1)); expect(value).toBe(item.prompts[locale]); captured.push({ language: locale, length: value.length, sha256: sha(Buffer.from(value)) });
          }
          await view.locator('#closeDialog').click(); await expect(view.locator('#detailDialog')).not.toBeVisible();
          rows.push({ theme, locale, viewport: { width, height }, searchBefore, searchAfter, scrolling, modal, baselineDeltas: deltas });
        }
        await view.setViewportSize({ width: 1440, height: 920 }); await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
        await expect(view.locator('#toast')).not.toHaveClass(/\bshow\b/); await settings();
        const panel = await view.locator('#settingsPanel').boundingBox(); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(1440); expect(panel.y + panel.height).toBeLessThanOrEqual(920);
        const frame = path.join(output, `i18n-settings-theme-gallery-${theme}-${locale}-1440x920.png`); await view.screenshot({ path: frame, scale: 'css', animations: 'disabled' }); frames.push(frame); await closeSettings();
      }
    }
    await settings(); await view.locator('#themeControl button[data-theme="dark"]').click(); await view.reload();
    await expect(view.locator('.portrait-card')).toHaveCount(50); await expect(view.locator('html')).toHaveAttribute('data-theme', 'dark'); expect(await view.evaluate(() => localStorage.getItem('portraitStudio.theme'))).toBe('dark');
    expect(apiRequests.every(request => request.method === 'GET')).toBe(true); expect(fs.readFileSync(indexPath)).toEqual(before); expect(fs.readFileSync(priorPath)).toEqual(priorBytes); expect(issues).toEqual([]);
    fs.writeFileSync(file, `${JSON.stringify(makeReport('passed'), null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', scope: 'settings-theme incremental', report: file, measurements: rows.length, copies: captured.length, screenshots: frames }));
  } catch (error) { fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('failed'), error: error.stack }, null, 2)}\n`); throw error; }
  finally { if (instance) await instance.close(); }
}

async function managementMenu() {
  const file = path.join(output, 'i18n-management-menu-verification.json');
  const priorPath = path.join(output, 'i18n-settings-theme-verification.json');
  const priorBytes = fs.readFileSync(priorPath);
  expect(JSON.parse(priorBytes).status).toBe('passed');
  const rows = [], frames = [], issues = [], apiRequests = [];
  let instance;
  const makeReport = status => ({ status, scope: 'Incremental SVG management menu and settings triggers, sticky header, read-only menu gates and actual GET refresh; modal and clipboard tests were not repeated', priorVerification: priorPath, priorVerificationSha256: sha(priorBytes), priorVerificationUnchanged: fs.readFileSync(priorPath).equals(priorBytes), url, browser: instance?.version(), actualCards: 50, measurements: rows, screenshots: frames, osClipboardReadOrWritten: false, nativeAppStarted: false, nativeCRUDTested: false, indexSha256Before: sha(before), indexSha256After: sha(fs.readFileSync(indexPath)), requests: apiRequests, errors: issues });
  try {
    instance = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await instance.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    const view = await context.newPage();
    view.on('pageerror', error => issues.push(error.message));
    view.on('console', message => { if (message.type() === 'error') issues.push({ text: message.text(), location: message.location() }); });
    view.on('request', request => { if (new URL(request.url()).pathname.startsWith('/__preview/api/')) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    await view.goto(url); await expect(view.locator('.portrait-card')).toHaveCount(50);
    console.log(JSON.stringify({ phase: 'management-menu preview reachable', url, actualCards: 50 }));
    const initial = await view.evaluate(() => window.portraitStudio.libraryList());
    expect(initial.ok).toBe(true); expect(initial.data.writable).toBe(false);
    const adapter = await view.evaluate(() => ({ mode: window.portraitStudio.mode, keys: Object.keys(window.portraitStudio).sort() }));
    expect(adapter.mode).toBe('browser-preview'); expect(adapter.keys).toEqual(['copyText', 'libraryGet', 'libraryList', 'mode', 'openImage']);
    async function openMenu() { await view.locator('#libraryMenuToggle').click(); await expect(view.locator('#libraryMenuPanel')).toBeVisible(); }
    async function menuGates(locale) {
      const labels = { '#libraryCreate': 'library.import', '#libraryConfigure': 'sidebar.switch', '#libraryBatch': 'sidebar.batch', '#libraryRefresh': 'sidebar.refresh' };
      for (const [selector, key] of Object.entries(labels)) { await expect(view.locator(selector)).toHaveText(messages[locale][key]); await expect(view.locator(`${selector} svg`)).toHaveCount(1); }
      for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) { await expect(view.locator(selector)).toBeDisabled(); await expect(view.locator(selector)).toHaveAttribute('title', messages[locale]['common.desktopOnly']); }
      await expect(view.locator('#libraryRefresh')).toBeEnabled();
      await expect(view.locator('#libraryStatus')).toHaveText(messages[locale]['sidebar.readonly']);
      await expect(view.locator('#libraryRoot')).toHaveText(path.join(root, 'photo_repo'));
      await expect(view.locator('#libraryMenuTitle')).toHaveText(messages[locale]['library.manage']);
    }
    for (const theme of ['dark', 'light']) {
      for (const locale of ['zh', 'en']) {
        await view.locator('#settingsToggle').click(); await expect(view.locator('#settingsPanel')).toBeVisible();
        await view.locator(`#themeControl button[data-theme="${theme}"]`).click(); await view.locator(`#uiLanguage button[data-language="${locale}"]`).click();
        await expect(view.locator('html')).toHaveAttribute('data-theme', theme); await expect(view.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
        await view.locator('#settingsPanel').press('Escape'); await expect(view.locator('#settingsPanel')).toHaveCount(0);
        for (const [selector, key] of [['#settingsToggle', 'settings.open'], ['#libraryMenuToggle', 'library.manage'], ['#gridToggle', 'header.density']]) {
          await expect(view.locator(`${selector} svg`)).toHaveCount(1); await expect(view.locator(selector)).toHaveAttribute('title', messages[locale][key]); await expect(view.locator(selector)).toHaveAttribute('aria-label', messages[locale][key]);
          expect(await view.locator(selector).evaluate(node => node.textContent.trim())).toBe('');
        }
        await expect(view.locator('.sidebar .library-controls,.sidebar #libraryCreate,.sidebar #libraryConfigure,.sidebar #libraryBatch,.sidebar #libraryRefresh')).toHaveCount(0);
        await expect(view.locator('.sidebar button')).toHaveCount(1); await expect(view.locator('.sidebar #settingsToggle')).toHaveCount(1);
        await expect(view.locator('.topbar #libraryMenuToggle')).toHaveCount(1);
        await expect(view.locator('.topbar #uiLanguage,.title-block,.toolbar-note,.sidebar-tip,.card-prompt-hint,#libraryNotice')).toHaveCount(0);
        await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
        const geometry = await view.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom, middleY: r.top + r.height / 2 }; };
          return { header: rect('.topbar'), search: rect('.search-actions'), menu: rect('#libraryMenuToggle') };
        });
        expect(geometry.header.height).toBe(82); expect(geometry.search.right).toBeLessThan(geometry.menu.left); expect(Math.abs(geometry.search.middleY - geometry.menu.middleY)).toBeLessThanOrEqual(1);
        await view.locator('.main-content').evaluate(node => { node.scrollTop = 400; });
        await expect.poll(() => view.locator('.main-content').evaluate(node => node.scrollTop)).toBe(400);
        const after = await view.locator('.search-actions').boundingBox(); expect(Math.abs(after.y - geometry.search.top)).toBeLessThanOrEqual(0.05);
        expect(await view.locator('.topbar').evaluate(node => getComputedStyle(node).position)).toBe('sticky');
        await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
        await openMenu(); await menuGates(locale);
        await view.locator('#libraryMenuPanel').press('Escape'); await expect(view.locator('#libraryMenuPanel')).toHaveCount(0); await expect(view.locator('#libraryMenuToggle')).toBeFocused();
        await openMenu(); await view.locator('#resultCount').click(); await expect(view.locator('#libraryMenuPanel')).toHaveCount(0);
        await openMenu(); await menuGates(locale);
        const reads = apiRequests.filter(request => request.path === '/__preview/api/library').length;
        await view.locator('#libraryRefresh').click(); await expect(view.locator('#libraryMenuPanel')).toHaveCount(0);
        await expect.poll(() => apiRequests.filter(request => request.path === '/__preview/api/library').length).toBe(reads + 1);
        await expect(view.locator('.portrait-card')).toHaveCount(50);
        await expect(view.locator('#toastMessage')).toHaveText(messages[locale]['app.refreshed']);
        const current = await view.evaluate(() => window.portraitStudio.libraryList()); expect(current).toEqual(initial);
        expect(await view.locator('.portrait-card').evaluateAll(nodes => nodes.map(node => Number(node.dataset.id)))).toEqual(index.items.map(item => item.id));
        rows.push({ theme, locale, ...geometry, searchAfterScroll400: after, actions: { importDisabled: true, configureDisabled: true, batchDisabled: true, refreshEnabled: true }, refreshRequests: 1, snapshotUnchanged: true, escapeFocusRestored: true, outsideCloses: true });
        if ((theme === 'dark' && locale === 'zh') || (theme === 'light' && locale === 'en')) {
          await expect(view.locator('#toast')).not.toHaveClass(/\bshow\b/); await view.mouse.move(10, 10);
          if (theme === 'light') await openMenu();
          const frame = path.join(output, `i18n-management-menu-gallery-${theme}-${locale}-1440x920.png`); await view.screenshot({ path: frame, scale: 'css', animations: 'disabled' }); frames.push(frame);
          if (theme === 'light') { await view.locator('#libraryMenuPanel').press('Escape'); await expect(view.locator('#libraryMenuPanel')).toHaveCount(0); }
        }
      }
    }
    expect(apiRequests.every(request => request.method === 'GET')).toBe(true); expect(fs.readFileSync(indexPath)).toEqual(before); expect(fs.readFileSync(priorPath)).toEqual(priorBytes); expect(issues).toEqual([]);
    fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('passed'), adapter }, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', scope: 'management-menu incremental', report: file, configurations: rows.length, realRefreshChecks: rows.length, screenshots: frames }));
  } catch (error) { fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('failed'), error: error.stack }, null, 2)}\n`); throw error; }
  finally { if (instance) await instance.close(); }
}

async function sidebarCollapse() {
  const file = path.join(output, 'i18n-sidebar-collapse-verification.json');
  const priorPath = path.join(output, 'i18n-management-menu-verification.json');
  const priorBytes = fs.readFileSync(priorPath);
  expect(JSON.parse(priorBytes).status).toBe('passed');
  const rows = [], frames = [], issues = [], apiRequests = [];
  let instance;
  const makeReport = status => ({ status, scope: 'Incremental sidebar persistence, keyboard and ARIA, actual flex layout and collapsed settings/menu reachability; no modal or copy regression', priorVerification: priorPath, priorVerificationSha256: sha(priorBytes), priorVerificationUnchanged: fs.readFileSync(priorPath).equals(priorBytes), url, browser: instance?.version(), actualCards: 50, measurements: rows, screenshots: frames, osClipboardReadOrWritten: false, nativeAppStarted: false, nativeCRUDTested: false, indexSha256Before: sha(before), indexSha256After: sha(fs.readFileSync(indexPath)), requests: apiRequests, errors: issues });
  try {
    instance = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await instance.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    const view = await context.newPage();
    view.on('pageerror', error => issues.push(error.message)); view.on('console', message => { if (message.type() === 'error') issues.push({ text: message.text(), location: message.location() }); });
    view.on('request', request => { if (new URL(request.url()).pathname.startsWith('/__preview/api/')) apiRequests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    await view.goto(url); await expect(view.locator('.portrait-card')).toHaveCount(50);
    console.log(JSON.stringify({ phase: 'sidebar-collapse preview reachable', url, actualCards: 50 }));
    await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', 'false');
    expect(await view.evaluate(() => localStorage.getItem('portraitStudio.sidebarCollapsed'))).toBe(null);
    await view.locator('#sidebarToggle').click(); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true');
    await view.reload(); await expect(view.locator('.portrait-card')).toHaveCount(50); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(await view.evaluate(() => localStorage.getItem('portraitStudio.sidebarCollapsed'))).toBe('true');
    await view.locator('#sidebarToggle').click(); await view.reload(); await expect(view.locator('.portrait-card')).toHaveCount(50); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', 'false');
    expect(await view.evaluate(() => localStorage.getItem('portraitStudio.sidebarCollapsed'))).toBe('false');
    await view.evaluate(() => document.activeElement.blur()); await view.keyboard.press('Tab'); await expect(view.locator('#sidebarToggle')).toBeFocused();
    await view.locator('#sidebarToggle').press('Space'); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', 'true'); await expect(view.locator('#sidebarToggle')).toHaveAttribute('aria-expanded', 'false');
    await view.locator('#sidebarToggle').press('Space'); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', 'false'); await expect(view.locator('#sidebarToggle')).toHaveAttribute('aria-expanded', 'true');
    async function collapse(value, locale) {
      if (await view.locator('.sidebar').getAttribute('data-collapsed') !== String(value)) await view.locator('#sidebarToggle').click();
      await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', String(value));
      await view.locator('.sidebar').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
      await expect(view.locator('#sidebarToggle')).toHaveAttribute('aria-expanded', String(!value));
      for (const name of ['aria-label', 'title']) await expect(view.locator('#sidebarToggle')).toHaveAttribute(name, messages[locale][value ? 'sidebar.expand' : 'sidebar.collapse']);
      await expect(view.locator('#sidebarToggle svg')).toHaveCount(1);
    }
    const geometry = () => view.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return { sidebar: rect('.sidebar'), main: rect('.main-content'), header: rect('.topbar'), documentWidth: document.documentElement.scrollWidth, viewport: { width: innerWidth, height: innerHeight } };
    });
    for (const theme of ['dark', 'light']) for (const locale of ['zh', 'en']) {
      await view.locator('#settingsToggle').click(); await expect(view.locator('#settingsPanel')).toBeVisible();
      await view.locator(`#themeControl button[data-theme="${theme}"]`).click(); await view.locator(`#uiLanguage button[data-language="${locale}"]`).click();
      await view.locator('#settingsPanel').press('Escape'); await expect(view.locator('#settingsPanel')).toHaveCount(0);
      for (const [width, height] of [[1440, 920], [1080, 720]]) {
        await view.setViewportSize({ width, height }); await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
        await collapse(false, locale); const expanded = await geometry();
        await collapse(true, locale); const collapsed = await geometry();
        expect(collapsed.sidebar.width).toBeLessThan(expanded.sidebar.width);
        const sidebarDifference = expanded.sidebar.width - collapsed.sidebar.width, mainGain = collapsed.main.width - expanded.main.width;
        expect(Math.abs(mainGain - sidebarDifference)).toBeLessThanOrEqual(0.05);
        expect(expanded.documentWidth).toBeLessThanOrEqual(width); expect(collapsed.documentWidth).toBeLessThanOrEqual(width);
        for (const selector of ['.sidebar .brand-text', '.sidebar .collection-card', '.sidebar .nav-label', '.sidebar .nav-count']) await expect(view.locator(selector)).not.toBeVisible();
        await expect(view.locator('.sidebar .nav-icon')).toBeVisible(); await expect(view.locator('#settingsToggle')).toBeVisible();
        await view.locator('#settingsToggle').click(); await expect(view.locator('#settingsPanel')).toBeVisible();
        const panel = await view.locator('#settingsPanel').boundingBox(); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(width); expect(panel.y + panel.height).toBeLessThanOrEqual(height);
        expect(await view.locator('#settingsPanel').evaluate(node => { const r = node.getBoundingClientRect(); return Boolean(document.elementFromPoint(r.right - 8, r.top + 28)?.closest('#settingsPanel')); })).toBe(true);
        await view.locator(`#uiLanguage button[data-language="${locale}"]`).click(); await view.locator(`#themeControl button[data-theme="${theme}"]`).click();
        await expect(view.locator('html')).toHaveAttribute('data-theme', theme); await expect(view.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
        await view.locator('#settingsPanel').press('Escape'); await expect(view.locator('#settingsToggle')).toBeFocused();
        const searchBefore = await view.locator('.search-actions').boundingBox(); await view.locator('.main-content').evaluate(node => { node.scrollTop = 400; });
        await expect.poll(() => view.locator('.main-content').evaluate(node => node.scrollTop)).toBe(400);
        const searchAfter = await view.locator('.search-actions').boundingBox(); expect(Math.abs(searchAfter.y - searchBefore.y)).toBeLessThanOrEqual(0.05); expect(await view.locator('.topbar').evaluate(node => getComputedStyle(node).position)).toBe('sticky');
        await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; }); await expect(view.locator('#libraryMenuToggle svg')).toHaveCount(1);
        await view.locator('#libraryMenuToggle').click(); await expect(view.locator('#libraryMenuPanel')).toBeVisible();
        for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) await expect(view.locator(selector)).toBeDisabled(); await expect(view.locator('#libraryRefresh')).toBeEnabled();
        await view.locator('#libraryMenuPanel').press('Escape'); await expect(view.locator('#libraryMenuPanel')).toHaveCount(0); await expect(view.locator('.portrait-card')).toHaveCount(50);
        rows.push({ theme, locale, viewport: { width, height }, expanded, collapsed, measuredSidebarReduction: sidebarDifference, measuredMainGain: mainGain, collapsedSettingsPanel: panel, settingsReachableOutsideSidebar: true, searchBefore, searchAfter, menuGates: { importDisabled: true, configureDisabled: true, batchDisabled: true, refreshEnabled: true } });
      }
      if ((theme === 'dark' && locale === 'zh') || (theme === 'light' && locale === 'en')) {
        await view.setViewportSize({ width: 1440, height: 920 }); await collapse(theme === 'light', locale); await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; }); await view.evaluate(() => document.activeElement.blur()); await view.mouse.move(10, 10);
        if (theme === 'light') { await view.locator('#settingsToggle').click(); await expect(view.locator('#settingsPanel')).toBeVisible(); }
        const frame = path.join(output, `i18n-sidebar-collapse-gallery-${theme}-${locale}-${theme === 'light' ? 'collapsed' : 'expanded'}-1440x920.png`); await view.screenshot({ path: frame, scale: 'css', animations: 'disabled' }); frames.push(frame);
        if (theme === 'light') await view.locator('#settingsPanel').press('Escape');
      }
    }
    expect(apiRequests.every(request => request.method === 'GET')).toBe(true); expect(fs.readFileSync(indexPath)).toEqual(before); expect(fs.readFileSync(priorPath)).toEqual(priorBytes); expect(issues).toEqual([]);
    fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('passed'), persistence: { defaultExpanded: true, collapsedReload: true, expandedReload: true, nativeTabAndSpaceToggle: true } }, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', report: file, configurations: rows.length, actualSidebarWidths: [...new Set(rows.flatMap(row => [row.expanded.sidebar.width, row.collapsed.sidebar.width]))], screenshots: frames }));
  } catch (error) { fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('failed'), error: error.stack }, null, 2)}\n`); throw error; }
  finally { if (instance) await instance.close(); }
}

async function sidebarMotion() {
  const file = path.join(output, 'i18n-sidebar-motion-verification.json');
  const priorPath = path.join(output, 'i18n-sidebar-collapse-verification.json');
  const priorBytes = fs.readFileSync(priorPath); expect(JSON.parse(priorBytes).status).toBe('passed');
  const rows = [], frames = [], issues = [];
  let instance;
  const makeReport = status => ({ status, scope: 'Incremental sidebar motion, chevron/search alignment, reduced motion and text clipping; no copy, modal or CRUD regression', priorVerification: priorPath, priorVerificationSha256: sha(priorBytes), priorVerificationUnchanged: fs.readFileSync(priorPath).equals(priorBytes), url, browser: instance?.version(), measurements: rows, screenshots: frames, osClipboardReadOrWritten: false, nativeAppStarted: false, indexSha256Before: sha(before), indexSha256After: sha(fs.readFileSync(indexPath)), errors: issues });
  try {
    instance = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await instance.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    const view = await context.newPage();
    view.on('pageerror', error => issues.push(error.message)); view.on('console', message => { if (message.type() === 'error') issues.push({ text: message.text(), location: message.location() }); });
    await view.goto(url); await expect(view.locator('.portrait-card')).toHaveCount(50);
    console.log(JSON.stringify({ phase: 'sidebar-motion preview reachable', url, actualCards: 50 }));
    const waitForMotion = () => view.locator('.sidebar').evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
    async function setCollapsed(value) { if (await view.locator('.sidebar').getAttribute('data-collapsed') !== String(value)) await view.locator('#sidebarToggle').click(); await waitForMotion(); }
    const measure = () => view.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom, middleY: r.top + r.height / 2 }; };
      const sidebar = document.querySelector('.sidebar'), css = getComputedStyle(sidebar);
      return { collapsed: sidebar.dataset.collapsed === 'true', sidebar: rect('.sidebar'), main: rect('.main-content'), fold: rect('#sidebarToggle'), svg: rect('#sidebarToggle svg'), search: rect('.search-actions'), header: rect('.topbar'), viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, transitions: { property: css.transitionProperty, duration: css.transitionDuration, delay: css.transitionDelay, easing: css.transitionTimingFunction }, texts: ['.brand-text', '.collection-card', '.nav-label'].map(selector => { const node = document.querySelector(selector), style = getComputedStyle(node); return { selector, whiteSpace: style.whiteSpace, visibility: style.visibility, opacity: style.opacity, overflowX: style.overflowX, display: style.display, maxWidth: style.maxWidth }; }) };
    });
    function alignment(row) {
      expect(Math.abs(row.fold.middleY - row.search.middleY)).toBeLessThanOrEqual(1);
      expect(row.fold.width).toBe(38); expect(row.fold.height).toBe(38); expect(row.svg.width).toBe(18); expect(row.svg.height).toBe(18);
      expect(row.documentWidth).toBeLessThanOrEqual(row.viewport.width);
      for (const text of row.texts) expect(text.whiteSpace).toBe('nowrap');
      if (row.collapsed) for (const text of row.texts) expect(text.visibility === 'hidden' || text.display === 'none' || Number(text.opacity) === 0).toBe(true);
    }
    async function animate(value, theme, locale) {
      const start = await measure(); alignment(start);
      await view.evaluate(() => {
        window.__portraitSidebarMotionFrames = []; window.__portraitSidebarMotionActive = true;
        const start = performance.now();
        const sample = () => {
          if (!window.__portraitSidebarMotionActive || performance.now() - start > 2000) return;
          const side = document.querySelector('.sidebar').getBoundingClientRect(), main = document.querySelector('.main-content').getBoundingClientRect();
          window.__portraitSidebarMotionFrames.push({ timeMs: performance.now() - start, collapsed: document.querySelector('.sidebar').dataset.collapsed === 'true', sidebarWidth: side.width, mainWidth: main.width, documentWidth: document.documentElement.scrollWidth, brandWhiteSpace: getComputedStyle(document.querySelector('.brand-text')).whiteSpace });
          requestAnimationFrame(sample);
        }; requestAnimationFrame(sample);
      });
      await view.locator('#sidebarToggle').click(); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', String(value)); await waitForMotion();
      const samples = await view.evaluate(() => { window.__portraitSidebarMotionActive = false; return window.__portraitSidebarMotionFrames; });
      const end = await measure(); alignment(end);
      const lower = Math.min(start.sidebar.width, end.sidebar.width), upper = Math.max(start.sidebar.width, end.sidebar.width);
      const middleFrames = samples.filter(sample => sample.sidebarWidth > lower + 1 && sample.sidebarWidth < upper - 1);
      expect(middleFrames.length).toBeGreaterThan(0); expect(Math.abs(end.sidebar.width - start.sidebar.width)).toBe(170);
      expect(Math.abs((end.main.width - start.main.width) + (end.sidebar.width - start.sidebar.width))).toBeLessThanOrEqual(0.05);
      for (const sample of samples) { expect(sample.documentWidth).toBeLessThanOrEqual(end.viewport.width); expect(Math.abs(sample.sidebarWidth + sample.mainWidth - end.viewport.width)).toBeLessThanOrEqual(0.05); expect(sample.brandWhiteSpace).toBe('nowrap'); }
      rows.push({ theme, locale, reducedMotion: false, start, end, middleFrameCount: middleFrames.length, samples });
    }
    const configure = async (theme, locale) => { await view.locator('#settingsToggle').click(); await expect(view.locator('#settingsPanel')).toBeVisible(); await view.locator(`#themeControl button[data-theme="${theme}"]`).click(); await view.locator(`#uiLanguage button[data-language="${locale}"]`).click(); await view.locator('#settingsPanel').press('Escape'); };
    for (const [theme, locale] of [['dark', 'zh'], ['light', 'en']]) {
      await configure(theme, locale); await setCollapsed(false);
      await animate(true, theme, locale); await animate(false, theme, locale);
      if (theme === 'light') await setCollapsed(true);
      await view.locator('.main-content').evaluate(node => { node.scrollTop = 0; }); await view.evaluate(() => document.activeElement.blur()); await view.mouse.move(10, 10);
      const frame = path.join(output, `i18n-sidebar-motion-gallery-${theme}-${locale}-${theme === 'light' ? 'collapsed' : 'expanded'}-1440x920.png`); await view.screenshot({ path: frame, scale: 'css', animations: 'disabled' }); frames.push(frame);
    }
    await view.setViewportSize({ width: 1080, height: 720 }); await configure('dark', 'zh'); await setCollapsed(false); await animate(true, 'dark', 'zh'); await animate(false, 'dark', 'zh');
    await view.emulateMedia({ reducedMotion: 'reduce' });
    for (const value of [true, false]) {
      const start = await measure(); await view.locator('#sidebarToggle').click(); await expect(view.locator('.sidebar')).toHaveAttribute('data-collapsed', String(value)); const end = await measure(); alignment(end);
      for (const duration of end.transitions.duration.split(',')) expect(parseFloat(duration)).toBe(0); for (const delay of end.transitions.delay.split(',')) expect(parseFloat(delay)).toBe(0);
      expect(Math.abs(end.sidebar.width - start.sidebar.width)).toBe(170); expect(Math.abs(end.main.width - start.main.width)).toBe(170);
      const active = await view.locator('.sidebar').evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length); expect(active).toBe(0);
      rows.push({ theme: 'dark', locale: 'zh', reducedMotion: true, start, end, activeAnimations: active });
    }
    const dialogCSS = await view.evaluate(() => {
      const rules = []; for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) if (rule.selectorText === '.detail-dialog') rules.push({ width: rule.style.width, height: rule.style.height, maxHeight: rule.style.maxHeight, padding: rule.style.padding });
      return rules;
    });
    const sourceDialogRule = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').match(/\.detail-dialog\s*\{([^}]+)\}/)?.[0];
    expect(sourceDialogRule).toContain('min(1030px, calc(100vw - 90px))');
    expect(sourceDialogRule).toContain('min(696.3203125px, calc(100dvh - 38px))');
    expect(dialogCSS.some(rule => rule.width.includes('1030px') && rule.width.includes('100vw') && rule.height.includes('696.32') && rule.height.includes('100dvh'))).toBe(true);
    await expect(view.locator('#detailDialog')).not.toBeVisible(); expect(fs.readFileSync(indexPath)).toEqual(before); expect(fs.readFileSync(priorPath)).toEqual(priorBytes); expect(issues).toEqual([]);
    fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('passed'), dialogEvidence: 'Existing fixed viewport-dependent CSS preserved; no modal was opened or sidebar interaction faked while modal', sourceDialogRule, dialogCSS }, null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', report: file, animatedTransitions: rows.filter(row => !row.reducedMotion).length, reducedMotionTransitions: rows.filter(row => row.reducedMotion).length, headerHeights: [...new Set(rows.flatMap(row => [row.start.header.height, row.end.header.height]))], screenshots: frames }));
  } catch (error) { fs.writeFileSync(file, `${JSON.stringify({ ...makeReport('failed'), error: error.stack }, null, 2)}\n`); throw error; }
  finally { if (instance) await instance.close(); }
}

(async () => {
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(url).hostname);
  expect(index.items.length).toBe(50);
  expect(baseline.status).toBe('passed');
  fs.mkdirSync(output, { recursive: true });
  if (process.env.PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE === 'clean-header') { await cleanHeader(); return; }
  if (process.env.PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE === 'settings-theme') { await settingsTheme(); return; }
  if (process.env.PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE === 'management-menu') { await managementMenu(); return; }
  if (process.env.PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE === 'sidebar-collapse') { await sidebarCollapse(); return; }
  if (process.env.PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE === 'sidebar-motion') { await sidebarMotion(); return; }
  try {
    browser = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      window.__singleLanguageCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__singleLanguageCopies.push(text); } } });
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push({ text: message.text(), location: message.location() }); });
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/__preview/api/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    await page.goto(url);
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    console.log(JSON.stringify({ phase: 'single-language preview reachable', actualCards: 50, url }));
    bridge = await page.evaluate(() => ({ mode: window.portraitStudio.mode, keys: Object.keys(window.portraitStudio).sort() }));
    expect(bridge.mode).toBe('browser-preview');
    expect(bridge.keys).toEqual(['copyText', 'libraryGet', 'libraryList', 'mode', 'openImage']);
    const snapshot = await page.evaluate(() => window.portraitStudio.libraryList());
    expect(snapshot.ok).toBe(true); expect(snapshot.data.writable).toBe(false);
    expect(snapshot.data.items.map(value => ({ id: value.id, type: value.type, label: value.label, prompts: value.prompts }))).toEqual(index.items.map(value => ({ id: value.id, type: value.type, label: value.label, prompts: value.prompts })));
    async function assertLanguage(locale) {
      await expect(page.locator('#uiLanguage')).toHaveCount(1);
      await expect(page.locator('.prompt-language')).toHaveCount(1);
      await expect(page.locator(`#uiLanguage button[data-language="${locale}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
      await expect(page).toHaveTitle(messages[locale]['app.title']);
      await expect(page.locator('.sidebar-tip,.card-prompt-hint,#detailUILanguage,.prompt-follow,#libraryNotice,.card-number,.card-title,#portraitType,#batchDefaultType')).toHaveCount(0);
      await expect(page.locator('.toolbar .prompt-language,.detail-intro .prompt-language')).toHaveCount(0);
      await expect(page.locator('.side-nav .nav-item')).toHaveCount(1);
      for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) await expect(page.locator(selector)).toBeDisabled();
      await expect(page.locator('.portrait-card')).toHaveCount(50);
    }
    async function open() { await page.locator('.portrait-card[data-id="1"]').click(); await expect(page.locator('#detailDialog')).toBeVisible(); await page.locator('#detailImage').evaluate(image => image.decode()); }
    async function close() { await page.locator('#closeDialog').click(); await expect(page.locator('#detailDialog')).not.toBeVisible(); }
    async function copy(locale, entrypoint, action) {
      const count = await page.evaluate(() => window.__singleLanguageCopies.length);
      await action(); await expect.poll(() => page.evaluate(() => window.__singleLanguageCopies.length)).toBe(count + 1);
      const value = await page.evaluate(() => window.__singleLanguageCopies.at(-1));
      expect(value).toBe(item.prompts[locale]); copies.push({ language: locale, entrypoint, length: value.length, sha256: sha(Buffer.from(value)) });
    }
    for (const locale of ['zh', 'en']) {
      await page.locator(`#uiLanguage button[data-language="${locale}"]`).click();
      await page.evaluate(other => { localStorage.setItem('portraitStudio.promptLanguageMode', other); localStorage.setItem('portraitStudio.promptLanguage', other); }, locale === 'zh' ? 'en' : 'zh');
      await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(50); await assertLanguage(locale);
      expect(await page.evaluate(() => localStorage.getItem('portraitStudio.uiLanguage'))).toBe(locale);
      for (const [width, height] of [[1440, 920], [1080, 720]]) {
        await page.setViewportSize({ width, height }); await open();
        await expect.poll(() => page.locator('#detailPrompt').textContent()).toBe(item.prompts[locale]);
        await expect(page.locator('#detailTitle')).toHaveText(item.label);
        await expect(page.locator('#detailKicker')).toHaveText(messages[locale]['detail.kicker']);
        await expect(page.locator('#detailCopy')).toContainText(messages[locale]['detail.copy']);
        const measured = await page.evaluate(() => {
          const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          return { dialog: rect(document.querySelector('#detailDialog')), copy: rect(document.querySelector('#detailCopy')), duplicateLanguageControls: document.querySelectorAll('#detailDialog .prompt-language').length, documentWidth: document.documentElement.scrollWidth };
        });
        const old = baseline.measurements.find(row => row.id === 1 && row.viewport.width === width && row.viewport.height === height).nodes['#detailDialog'].rect;
        const deltas = Object.fromEntries(['top', 'left', 'width', 'height'].map(key => [key, measured.dialog[key] - old[key]]));
        measurements.push({ uiLanguage: locale, promptLanguage: locale, viewport: { width, height }, baselineDialog: old, baselineDeltas: deltas, ...measured });
        for (const delta of Object.values(deltas)) expect(Math.abs(delta)).toBeLessThanOrEqual(0.05);
        expect(measured.copy.bottom).toBeLessThanOrEqual(measured.dialog.bottom); expect(measured.copy.top).toBeGreaterThanOrEqual(measured.dialog.top);
        expect(measured.documentWidth).toBeLessThanOrEqual(width); expect(measured.duplicateLanguageControls).toBe(0);
        if (width === 1440) {
          await copy(locale, 'detail button', () => page.locator('#detailCopy').click());
          await copy(locale, 'detail Cmd Enter', () => page.locator('#detailDialog').press('Meta+Enter'));
        }
        await close();
      }
      await page.setViewportSize({ width: 1440, height: 920 });
      const card = page.locator('.portrait-card[data-id="1"]'); await card.hover();
      await copy(locale, 'card button', () => card.locator('.copy-button').click());
      await card.focus(); await copy(locale, 'card C', () => card.press('c'));
      await expect(page.locator('#toast')).not.toHaveClass(/\bshow\b/);
      await page.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
      await page.locator('#resultCount').click(); await page.mouse.move(10, 10);
      const screenshot = path.join(output, `i18n-single-language-gallery-${locale}-1440x920.png`);
      await page.screenshot({ path: screenshot, scale: 'css', animations: 'disabled' }); screenshots.push(screenshot);
    }
    checks.push('A single top-right interface language entry controls system text and exact original full prompts; all duplicate prompt-language controls and three removed hints are absent');
    checks.push('Chinese and English persist after reload while both opposite legacy prompt language preferences are ignored');
    checks.push('Four modal rectangles at 1440×920 and 1080×720 preserve the sealed Chinese native baseline and keep copy visible');
    checks.push('Eight isolated-page full-prompt captures cover detail button, Cmd Enter, card button and card C in both languages');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(fs.readFileSync(indexPath)).toEqual(before); expect(errors).toEqual([]);
    checks.push('All 50 real records are read-only, native writing APIs are absent, management buttons are disabled and the source index bytes are unchanged');
    fs.writeFileSync(reportPath, `${JSON.stringify(report('passed'), null, 2)}\n`);
    console.log(JSON.stringify({ status: 'passed', report: reportPath, copies: copies.length, measurements: measurements.length, screenshots, maxDialogDelta: Math.max(...measurements.flatMap(row => Object.values(row.baselineDeltas).map(Math.abs))) }));
  } catch (error) {
    fs.writeFileSync(reportPath, `${JSON.stringify({ ...report('failed'), error: error.stack }, null, 2)}\n`); throw error;
  } finally { if (browser) await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
