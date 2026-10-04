const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { _electron: electron, chromium, expect } = require('@playwright/test');
const project = path.resolve(__dirname, '..');
const output = path.join(project, '.verification');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const mode = process.env.PORTRAIT_STUDIO_I18N_MODE || 'browser';

async function baseline() {
  const executable = process.env.PORTRAIT_STUDIO_EXECUTABLE || path.join(project, 'release/archives/1.5.0/runtime/mac-arm64/Portrait Studio.app/Contents/MacOS/Portrait Studio');
  const actualRoot = path.join(project, 'photo_repo');
  const indexPath = path.join(actualRoot, '.portrait-studio/library.json');
  const indexBefore = fs.readFileSync(indexPath);
  const index = JSON.parse(indexBefore);
  expect(index.items.length).toBe(50);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-i18n-baseline-'));
  const profile = path.join(temporary, 'isolated-profile');
  fs.mkdirSync(profile);
  fs.mkdirSync(output, { recursive: true });
  const measurements = [];
  const errors = [];
  let app;
  let security;
  let cssRules;
  const file = path.join(output, 'i18n-cn-modal-baseline.json');
  try {
    const environment = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete environment.PORTRAIT_STUDIO_LIBRARY_DIR;
    app = await electron.launch({ executablePath: executable, args: [], env: environment });
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    security = await app.evaluate(({ app, BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { pid: process.pid, version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData'), contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox, webSecurity: prefs.webSecurity };
    });
    expect(security.version).toBe('1.5.0');
    expect(security.userData).toBe(profile);
    expect(security.contextIsolation).toBe(true);
    expect(security.nodeIntegration).toBe(false);
    expect(security.sandbox).toBe(true);
    expect(security.webSecurity).toBe(true);
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    const state = await page.evaluate(() => window.portraitStudio.libraryList());
    expect(state.ok).toBe(true);
    expect(state.data.root).toBe(fs.realpathSync(actualRoot));
    cssRules = await page.evaluate(() => {
      const result = [];
      function visit(rules, conditions = []) {
        for (const rule of rules) {
          if (rule.selectorText && /detail-dialog|detail-layout|detail-copy|detail-image-wrap|detail-intro|prompt-box|detail-actions|detail-management|detail-hint|dialog-close/.test(rule.selectorText)) result.push({ conditions, selector: rule.selectorText, css: rule.style.cssText });
          else if (rule.cssRules) visit(rule.cssRules, [...conditions, rule.conditionText || rule.cssText.split('{')[0]]);
        }
      }
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
      return result;
    });
    for (const [width, height] of [[1440, 920], [2048, 1280], [1080, 720]]) {
      await page.setViewportSize({ width, height });
      for (const id of [1, 25, 50]) {
        const item = index.items.find(item => item.id === id);
        const number = String(id).padStart(3, '0');
        const card = page.locator('.portrait-card').filter({ has: page.locator('.card-number', { hasText: new RegExp(`^${number}$`) }) });
        await card.click();
        await expect(page.locator('#detailDialog')).toBeVisible();
        await page.locator('#detailDialog').getByRole('group', { name: '提示词语言' }).getByRole('button', { name: '中文', exact: true }).click();
        await expect.poll(() => page.locator('#detailPrompt').textContent()).toBe(item.prompts.zh);
        await page.locator('#detailImage').evaluate(image => image.decode());
        const measurement = await page.evaluate(() => {
          const names = ['#detailDialog', '.detail-layout', '.detail-image-wrap', '.detail-copy', '#detailTitle', '.detail-intro', '.prompt-box', '#detailPrompt', '.detail-actions', '#detailCopy', '#detailOpen', '.detail-management', '.detail-hint'];
          const properties = ['display','position','boxSizing','width','height','minWidth','maxWidth','minHeight','maxHeight','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','overflow','overflowX','overflowY','gridTemplateColumns','flexDirection','flexGrow','flexShrink','flexBasis','gap','fontSize','lineHeight','whiteSpace'];
          const nodes = {};
          for (const name of names) {
            const node = document.querySelector(name);
            if (!node) { nodes[name] = null; continue; }
            const rect = node.getBoundingClientRect(), computed = getComputedStyle(node);
            const css = Object.fromEntries(properties.map(property => [property, computed[property]]));
            nodes[name] = { rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }, css, clientWidth: node.clientWidth, clientHeight: node.clientHeight, scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, textLength: node.textContent.length, fullyInsideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
          }
          const box = document.querySelector('.prompt-box');
          box.scrollTop = box.scrollHeight;
          const scroll = { clientHeight: box.clientHeight, scrollHeight: box.scrollHeight, maximumReached: box.scrollTop };
          box.scrollTop = 0;
          return { viewport: { width: innerWidth, height: innerHeight }, nodes, scroll, documentOverflow: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
        });
        measurements.push({ id, language: 'zh', promptLength: item.prompts.zh.length, promptSha256: sha(Buffer.from(item.prompts.zh)), ...measurement });
        if (width === 1440 && id === 1) await page.screenshot({ path: path.join(output, 'i18n-cn-modal-baseline-1440x920.png'), scale: 'css', animations: 'disabled' });
        await page.locator('#closeDialog').click();
        await expect(page.locator('#detailDialog')).not.toBeVisible();
      }
    }
    expect(fs.readFileSync(indexPath)).toEqual(indexBefore);
    expect(errors).toEqual([]);
    const report = { status: 'passed', mode: 'sealed-1.5-chinese-measurement', executable, actualRoot, profile, security, indexSha256Before: sha(indexBefore), indexSha256After: sha(fs.readFileSync(indexPath)), indexUnchanged: true, clipboardReadOrWritten: false, cssRules, measurements, errors };
    fs.writeFileSync(file, json(report));
    console.log(json({ status: 'passed', report: file, security, measurements: measurements.map(row => ({ id: row.id, viewport: row.viewport, dialog: row.nodes['#detailDialog'].rect, layout: row.nodes['.detail-layout'].rect, promptBox: row.nodes['.prompt-box'].rect, scroll: row.scroll, copy: row.nodes['#detailCopy'].rect })) }));
  } catch (error) {
    fs.writeFileSync(file, json({ status: 'failed', mode, executable, profile, security, cssRules, measurements, errors, error: error.stack }));
    throw error;
  } finally { if (app) await app.close(); }
}

async function browserPreview() {
  const url = process.env.PORTRAIT_STUDIO_PREVIEW_URL || 'http://127.0.0.1:5173';
  const parsedURL = new URL(url);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(parsedURL.hostname);
  const kind = process.env.PORTRAIT_STUDIO_VERIFICATION_KIND || 'i18n-browser';
  if (!/^i18n-[a-z0-9-]+$/.test(kind)) throw new Error('Verification kind must use the i18n- prefix');
  const actualRoot = path.join(project, 'photo_repo');
  const indexPath = path.join(actualRoot, '.portrait-studio/library.json');
  const indexBefore = fs.readFileSync(indexPath);
  const index = JSON.parse(indexBefore);
  expect(index.items.length).toBe(50);
  const imageFingerprints = () => index.items.map(item => ({ id: item.id, image: item.image, sha256: sha(fs.readFileSync(path.join(actualRoot, 'assets/images', item.image))) }));
  const imagesBefore = imageFingerprints();
  const baselineFile = path.join(output, 'i18n-cn-modal-baseline.json');
  const oldModal = JSON.parse(fs.readFileSync(baselineFile));
  expect(oldModal.status).toBe('passed');
  expect(oldModal.mode).toBe('sealed-1.5-chinese-measurement');
  const uiMessages = JSON.parse(fs.readFileSync(path.join(project, 'src/ui-messages.json')));
  const systemMessages = JSON.parse(fs.readFileSync(path.join(project, 'system-messages.json')));
  const text = (locale, key, params = {}) => (uiMessages[locale][key] ?? systemMessages[locale][key]).replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(params[key] ?? ''));
  const measurements = [], screenshots = [], copies = [], requests = [], errors = [], checks = [];
  const reportPath = path.join(output, `${kind}-verification.json`);
  let browser;
  let page;
  let bridge;
  let currentPhase = 'launch isolated headless browser';
  fs.mkdirSync(output, { recursive: true });
  const snapshotReport = status => ({ status, mode: 'read-only-browser-preview', url, browserVersion: browser?.version(), actualRoot, baselineFile, baselineSha256: sha(fs.readFileSync(baselineFile)), indexSha256Before: sha(indexBefore), indexSha256After: sha(fs.readFileSync(indexPath)), imagesBefore, imagesAfter: imageFingerprints(), osClipboardReadOrWritten: false, clipboardEvidence: 'navigator.clipboard.writeText is captured inside an isolated page; this is not a native clipboard test', nativeDialogsTested: false, nativeCRUDTested: false, bridge, currentPhase, checks, measurements, screenshots, copies, requests, errors });
  try {
    browser = await chromium.launch({ executablePath: process.env.PORTRAIT_STUDIO_BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      window.__i18nCopies = [];
      window.__i18nRejectCopy = false;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => {
        if (window.__i18nRejectCopy) throw new Error('Isolated test clipboard failure');
        window.__i18nCopies.push(value);
      } } });
    });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/__preview/api/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    page.on('console', message => { if (message.type() === 'error') errors.push({ text: message.text(), location: message.location() }); });
    await page.goto(url);
    await expect(page.locator('.portrait-card')).toHaveCount(50);
    console.log(JSON.stringify({ phase: 'preview reachable', url, actualCards: await page.locator('.portrait-card').count(), pageTitle: await page.title() }));
    bridge = await page.evaluate(() => ({ mode: window.portraitStudio?.mode, keys: Object.keys(window.portraitStudio ?? {}), nodeRequire: typeof window.require, nodeProcess: typeof window.process }));
    expect(bridge.mode).toBe('browser-preview');
    expect(bridge.nodeRequire).toBe('undefined');
    expect(bridge.nodeProcess).toBe('undefined');
    const forbidden = ['chooseLibrary', 'chooseImage', 'createPortrait', 'updatePortrait', 'deletePortrait', 'chooseBatchImages', 'chooseBatchManifest', 'previewBatch', 'commitBatch', 'cancelBatch', 'getUpdateState', 'checkForUpdates', 'chooseUpdateSource', 'downloadUpdate', 'installUpdate', 'onUpdateState', 'acknowledgeAppReady'];
    for (const name of forbidden) expect(bridge.keys).not.toContain(name);
    const state = await page.evaluate(() => window.portraitStudio.libraryList());
    expect(state.ok).toBe(true);
    expect(state.data.root).toBe(fs.realpathSync(actualRoot));
    expect(state.data.writable).toBe(false);
    expect(state.data.items.map(item => item.id)).toEqual(index.items.map(item => item.id));
    for (const item of index.items) {
      const actual = state.data.items.find(value => value.id === item.id);
      expect({ id: actual.id, label: actual.label, type: actual.type, prompts: actual.prompts, sourceMetadata: actual.sourceMetadata }).toEqual({ id: item.id, label: item.label, type: item.type, prompts: item.prompts, sourceMetadata: item.sourceMetadata });
    }
    checks.push('All 50 IDs, types, names, both complete prompts and original source metadata match the real read-only index');

    const uiButton = locale => page.locator(`#uiLanguage button[data-language="${locale}"]`);
    const promptGroup = scope => scope.locator('.prompt-language').filter({ has: page.locator('.prompt-follow') });
    async function assertUI(locale) {
      await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
      await expect(page).toHaveTitle(text(locale, 'app.title'));
      const labels = {
        '.brand-subtitle': 'sidebar.subtitle', '.collection-kicker': 'sidebar.collection', '.collection-title': 'sidebar.title',
        '.crumb': 'header.crumb', 'h1': 'header.title', '.title-block p': 'header.description', '.sidebar-tip strong': 'sidebar.quickCopy',
        '.sidebar-tip p': 'sidebar.quickCopyHint', '#libraryStatus': 'sidebar.readonly', '#libraryLocationHelp strong': 'sidebar.location',
        '#libraryLocationHelp p': 'sidebar.locationHint', '#libraryCreate': 'sidebar.import', '#libraryConfigure': 'sidebar.switch',
        '#libraryBatch': 'sidebar.batch', '#libraryNotice': 'app.browserPreview', '.toolbar-note': 'gallery.hoverCopy',
      };
      for (const [selector, key] of Object.entries(labels)) await expect(page.locator(selector)).toHaveText(text(locale, key));
      await expect(page.locator('#totalCount')).toHaveText(text(locale, 'sidebar.count', { count: 50 }));
      await expect(page.locator('#resultCount')).toHaveText(text(locale, 'gallery.resultCount', { count: 50 }));
      await expect(page.locator('#searchInput')).toHaveAttribute('placeholder', text(locale, 'header.search'));
      await expect(page.locator('#searchInput')).toHaveAttribute('aria-label', text(locale, 'header.search'));
      await expect(page.locator('#gridToggle')).toHaveAttribute('aria-label', text(locale, 'header.density'));
      await expect(page.locator('#uiLanguage')).toHaveAttribute('aria-label', text(locale, 'ui.language'));
      await expect(page.locator('.side-nav')).toHaveAttribute('aria-label', text(locale, 'sidebar.navigation'));
      await expect(page.locator('#libraryRefresh')).toHaveAttribute('title', text(locale, 'sidebar.refresh'));
      for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) {
        await expect(page.locator(selector)).toBeDisabled();
        await expect(page.locator(selector)).toHaveAttribute('title', text(locale, 'common.desktopOnly'));
      }
      await expect(page.locator('#libraryRefresh')).toBeEnabled();
      await expect(page.locator('#libraryRoot')).toHaveText(fs.realpathSync(actualRoot));
      await expect(page.locator('.card-number,.card-title,#portraitType,#batchDefaultType,#appUpdate')).toHaveCount(0);
      await expect(page.locator('.side-nav .nav-item')).toHaveCount(1);
      await expect(page.locator('[data-filter="photo"],[data-filter="art"]')).toHaveCount(0);
      await expect(page.locator('.card-prompt-hint').first()).toHaveText(text(locale, 'gallery.viewPrompt'));
      await expect(promptGroup(page.locator('.toolbar'))).toHaveAttribute('aria-label', text(locale, 'prompt.language'));
      await expect(page.locator('.toolbar .prompt-follow')).toHaveText(text(locale, 'prompt.follow'));
    }
    async function setUI(locale) { await uiButton(locale).click(); await assertUI(locale); }
    async function setPrompt(locale, scope = page.locator('.toolbar')) { await promptGroup(scope).getByRole('button', { name: locale === 'en' ? 'English' : '中文', exact: true }).click(); }
    async function assertPrompt(item, locale, uiLocale) {
      await expect.poll(() => page.locator('#detailPrompt').textContent()).toBe(item.prompts[locale]);
      await expect(page.locator('#detailPrompt')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
      await expect(page.locator('#detailTitle')).toHaveText(item.label);
      await expect(page.locator('#detailKicker')).toHaveText(text(uiLocale, 'detail.kicker'));
      await expect(page.locator('.detail-intro > span')).toHaveText(text(uiLocale, 'detail.intro'));
      await expect(page.locator('#detailCopy')).toContainText(text(uiLocale, 'detail.copy'));
      await expect(page.locator('#detailOpen')).toHaveText(text(uiLocale, 'detail.openImage'));
      await expect(page.locator('.detail-hint')).toHaveText(text(uiLocale, 'detail.shortcuts'));
      await expect(page.locator('#closeDialog')).toHaveAttribute('aria-label', text(uiLocale, 'detail.close'));
      await expect(page.locator('#detailUILanguage')).toHaveAttribute('aria-label', text(uiLocale, 'ui.language'));
      await expect(page.locator(`#detailUILanguage button[data-language="${uiLocale}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(promptGroup(page.locator('#detailDialog'))).toHaveAttribute('aria-label', text(uiLocale, 'prompt.language'));
      await expect(page.locator('#detailEdit,#detailDelete')).toHaveCount(0);
    }
    async function open(id) {
      await page.locator(`.portrait-card[data-id="${id}"]`).click();
      await expect(page.locator('#detailDialog')).toBeVisible();
      await page.locator('#detailImage').evaluate(image => image.decode());
    }
    async function close() { await page.locator('#closeDialog').click(); await expect(page.locator('#detailDialog')).not.toBeVisible(); }
    async function copy(item, language, entrypoint, action) {
      const before = await page.evaluate(() => window.__i18nCopies.length);
      await action();
      await expect.poll(() => page.evaluate(() => window.__i18nCopies.length)).toBe(before + 1);
      const actual = await page.evaluate(() => window.__i18nCopies.at(-1));
      expect(actual).toBe(item.prompts[language]);
      copies.push({ id: item.id, language, entrypoint, length: actual.length, sha256: sha(Buffer.from(actual)) });
    }
    currentPhase = 'default follow, runtime interface language and independent prompt persistence';
    await assertUI('zh');
    await expect(page.locator('.toolbar .prompt-follow')).toHaveAttribute('aria-pressed', 'true');
    await open(1); await assertPrompt(index.items.find(item => item.id === 1), 'zh', 'zh');
    const beforeLiveSwitch = await page.locator('#detailDialog').boundingBox();
    await page.locator('#detailUILanguage button[data-language="en"]').click();
    await assertPrompt(index.items.find(item => item.id === 1), 'en', 'en');
    expect(await page.locator('#detailDialog').boundingBox()).toEqual(beforeLiveSwitch);
    await page.locator('#detailUILanguage button[data-language="zh"]').click();
    await assertPrompt(index.items.find(item => item.id === 1), 'zh', 'zh');
    expect(await page.locator('#detailDialog').boundingBox()).toEqual(beforeLiveSwitch);
    await close();
    await setUI('en');
    await open(1); await assertPrompt(index.items.find(item => item.id === 1), 'en', 'en'); await close();
    await setPrompt('zh'); await setUI('zh'); await setUI('en');
    await open(1); await assertPrompt(index.items.find(item => item.id === 1), 'zh', 'en'); await close();
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(50); await assertUI('en');
    await expect(page.locator('.toolbar .prompt-follow')).toHaveAttribute('aria-pressed', 'false');
    await open(1); await assertPrompt(index.items.find(item => item.id === 1), 'zh', 'en'); await close();
    expect(await page.evaluate(() => ({ ui: localStorage.getItem('portraitStudio.uiLanguage'), prompt: localStorage.getItem('portraitStudio.promptLanguageMode') }))).toEqual({ ui: 'en', prompt: 'zh' });
    await page.locator('.toolbar .prompt-follow').click();
    await setUI('zh'); await open(1); await assertPrompt(index.items.find(item => item.id === 1), 'zh', 'zh'); await close();
    await setUI('en'); await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(50); await assertUI('en');
    await expect(page.locator('.toolbar .prompt-follow')).toHaveAttribute('aria-pressed', 'true');
    checks.push('Default Chinese interface follows prompt language; independent Chinese remains across interface switches/reload; reset-to-follow and English preference persist');

    currentPhase = 'same-viewport native Chinese baseline comparison, bilingual complete prompt scrolling and copy';
    for (const [width, height] of [[1440, 920], [2048, 1280], [1080, 720]]) {
      await page.setViewportSize({ width, height });
      for (const uiLocale of ['zh', 'en']) {
        await setUI(uiLocale);
        await page.locator('.toolbar .prompt-follow').click();
        await page.locator('.main-content').evaluate(node => { node.scrollTop = 0; });
        if (width === 1440) {
          await expect(page.locator('#toast')).not.toHaveClass(/\bshow\b/);
          const screenshot = path.join(output, `${kind}-gallery-${uiLocale}-${width}x${height}.png`);
          await page.screenshot({ path: screenshot, scale: 'css', animations: 'disabled' }); screenshots.push(screenshot);
        }
        for (const id of [1, 25, 50]) {
          const item = index.items.find(item => item.id === id);
          await open(id);
          for (const promptLocale of ['zh', 'en']) {
            await setPrompt(promptLocale, page.locator('#detailDialog'));
            await assertPrompt(item, promptLocale, uiLocale);
            const measurement = await page.evaluate(() => {
              const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
              const dialog = document.querySelector('#detailDialog'), layout = document.querySelector('.detail-layout'), box = document.querySelector('.prompt-box'), copy = document.querySelector('#detailCopy'), controls = document.querySelector('.detail-intro .prompt-language');
              box.scrollTop = box.scrollHeight;
              const scroll = { clientHeight: box.clientHeight, scrollHeight: box.scrollHeight, maximumReached: box.scrollTop, overflowY: getComputedStyle(box).overflowY };
              const result = { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(dialog), layout: rect(layout), promptBox: rect(box), copy: rect(copy), promptControls: rect(controls), scroll, outerScroll: { top: dialog.scrollTop, left: dialog.scrollLeft, width: dialog.scrollWidth, height: dialog.scrollHeight, clientWidth: dialog.clientWidth, clientHeight: dialog.clientHeight }, documentOverflow: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, promptMode: localStorage.getItem('portraitStudio.promptLanguageMode') };
              box.scrollTop = 0;
              return result;
            });
            const original = oldModal.measurements.find(row => row.id === id && row.viewport.width === width && row.viewport.height === height).nodes['#detailDialog'].rect;
            measurement.baselineDialog = original;
            measurement.baselineDeltas = Object.fromEntries(['top', 'left', 'width', 'height'].map(key => [key, measurement.dialog[key] - original[key]]));
            measurements.push({ id, uiLanguage: uiLocale, promptLanguage: promptLocale, promptLength: item.prompts[promptLocale].length, promptSha256: sha(Buffer.from(item.prompts[promptLocale])), ...measurement });
            for (const key of ['top', 'left', 'width', 'height']) expect(Math.abs(measurement.baselineDeltas[key]), `${width}x${height} ID ${id} ${uiLocale}/${promptLocale} modal ${key}`).toBeLessThanOrEqual(0.05);
            expect(measurement.scroll.overflowY).toBe('auto');
            if (promptLocale === 'en') expect(measurement.scroll.maximumReached).toBeGreaterThan(0);
            expect(measurement.dialog.left).toBeGreaterThanOrEqual(0); expect(measurement.dialog.top).toBeGreaterThanOrEqual(0);
            expect(measurement.dialog.right).toBeLessThanOrEqual(width); expect(measurement.dialog.bottom).toBeLessThanOrEqual(height);
            expect(measurement.copy.top).toBeGreaterThanOrEqual(measurement.dialog.top); expect(measurement.copy.bottom).toBeLessThanOrEqual(measurement.dialog.bottom);
            expect(measurement.copy.right).toBeLessThanOrEqual(measurement.dialog.right);
            expect(measurement.promptControls.right).toBeLessThanOrEqual(measurement.dialog.right);
            expect(measurement.outerScroll.top).toBe(0); expect(measurement.outerScroll.left).toBe(0);
            expect(measurement.layout.bottom).toBeLessThanOrEqual(measurement.dialog.bottom);
            expect(measurement.documentOverflow.width).toBeLessThanOrEqual(width);
            await copy(item, promptLocale, 'detail button', () => page.locator('#detailCopy').click());
            await expect(page.locator('#toastMessage')).toHaveText(text(uiLocale, 'app.promptCopied', { number: String(id).padStart(3, '0'), language: text(uiLocale, promptLocale === 'zh' ? 'app.chinese' : 'app.english') }));
            if (id === 1 && (width === 1440 || width === 1080)) {
              const screenshot = path.join(output, `${kind}-modal-ui-${uiLocale}-prompt-${promptLocale}-${width}x${height}.png`);
              await page.screenshot({ path: screenshot, scale: 'css', animations: 'disabled' }); screenshots.push(screenshot);
            }
          }
          await close();
        }
      }
      console.log(JSON.stringify({ phase: currentPhase, viewport: { width, height }, measurements: measurements.length, isolatedCopies: copies.length }));
    }
    checks.push('36 independently captured modal rectangles match the sealed native Chinese baseline at three viewports; English content scrolls inside the fixed frame while copy stays visible');

    currentPhase = 'scoped keyboard/card copy, browsing, searches and translated errors';
    await page.setViewportSize({ width: 1440, height: 920 });
    const first = index.items.find(item => item.id === 1);
    for (const uiLocale of ['zh', 'en']) {
      await setUI(uiLocale);
      for (const promptLocale of ['zh', 'en']) {
        await setPrompt(promptLocale);
        const card = page.locator('.portrait-card[data-id="1"]');
        await card.hover(); await copy(first, promptLocale, 'card button', () => card.locator('.copy-button').click());
        await card.focus(); await copy(first, promptLocale, 'card C', () => card.press('c'));
        await open(1); await copy(first, promptLocale, 'detail Meta Enter', () => page.locator('#detailDialog').press('Meta+Enter')); await close();
      }
      await page.locator('#searchInput').fill(first.label);
      await expect(page.locator('.portrait-card')).toHaveCount(1);
      await expect(page.locator('.portrait-card')).toHaveAttribute('data-id', '1');
      await page.locator('#searchInput').fill('i18n-unmatched-fixture-no-real-record');
      await expect(page.locator('.portrait-card')).toHaveCount(0);
      await expect(page.locator('#emptyState h2')).toHaveText(text(uiLocale, 'gallery.noResults'));
      await expect(page.locator('#emptyState p')).toHaveText(text(uiLocale, 'gallery.noResultsHint'));
      await page.locator('#searchInput').fill(''); await expect(page.locator('.portrait-card')).toHaveCount(50);
      await page.locator('#gridToggle').click(); await expect(page.locator('#gallery')).toHaveClass('gallery dense');
      await page.locator('#gridToggle').click(); await expect(page.locator('#gallery')).toHaveClass('gallery');
      await setPrompt('en'); await open(1); await page.locator('#detailDialog').press('ArrowRight'); await expect(page.locator('#detailTitle')).toHaveText(index.items.find(item => item.id === 2).label);
      await page.locator('#detailDialog').press('ArrowLeft'); await expect(page.locator('#detailTitle')).toHaveText(first.label);
      await page.evaluate(() => { window.__i18nRejectCopy = true; }); await page.locator('#detailCopy').click();
      await expect(page.locator('#toastMessage')).toHaveText(text(uiLocale, 'app.copyFailed'));
      await page.evaluate(() => { window.__i18nRejectCopy = false; }); await close();
      await page.route('**/__preview/api/portraits/1', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: '<img src=x onerror=alert(1)> untranslated raw error' } }) }));
      await page.locator('.portrait-card[data-id="1"]').click();
      await expect(page.locator('#toastMessage')).toHaveText(text(uiLocale, 'errors.CONFLICT'));
      await expect(page.locator('#detailDialog')).not.toBeVisible();
      await expect(page.locator('#toast img')).toHaveCount(0);
      await page.unroute('**/__preview/api/portraits/1');
    }
    checks.push('Both UI languages localize copy success/failure, coded read errors and empty searches; full prompt copy has four scoped entrypoints; left/right navigation, names and density remain functional');
    currentPhase = 'invalid stored preferences safely reset and read-only invariants';
    await page.evaluate(() => { localStorage.setItem('portraitStudio.uiLanguage', 'invalid'); localStorage.setItem('portraitStudio.promptLanguageMode', 'invalid'); localStorage.removeItem('portraitStudio.promptLanguage'); });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(50); await assertUI('zh');
    await expect(page.locator('.toolbar .prompt-follow')).toHaveAttribute('aria-pressed', 'true');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(fs.readFileSync(indexPath)).toEqual(indexBefore);
    expect(imageFingerprints()).toEqual(imagesBefore);
    expect(errors).toEqual([]);
    checks.push('Every preview API request is GET; no native write bridge exists; the real 50-image index and all image hashes remain unchanged; invalid saved preferences fall back to Chinese/follow');
    currentPhase = 'complete';
    fs.writeFileSync(reportPath, json(snapshotReport('passed')));
    console.log(json({ status: 'passed', report: reportPath, browser: browser.version(), measurements: measurements.length, isolatedCopyChecks: copies.length, checks, screenshotCount: screenshots.length, nativeClipboardTested: false }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, `${kind}-failure.png`), animations: 'disabled' }).catch(() => {});
    fs.writeFileSync(reportPath, json({ ...snapshotReport('failed'), error: error.stack }));
    throw error;
  } finally { if (browser) await browser.close(); }
}

(async () => {
  if (mode === 'baseline') await baseline();
  else if (mode === 'browser') await browserPreview();
  else throw new Error('PORTRAIT_STUDIO_I18N_MODE must be baseline or browser');
})().catch(error => { console.error(error); process.exitCode = 1; });
