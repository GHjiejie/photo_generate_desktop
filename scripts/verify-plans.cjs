'use strict';

// Actual production Electron, preload and local IPC using owned image/library
// fixtures and an isolated profile. Native picker results and clipboard writes
// are substituted only inside this test Electron process.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LocalLibrary } = require('../local-library.cjs');
const { prepareBatchImport } = require('../batch-import.cjs');

const project = path.resolve(__dirname, '..'), output = path.join(project, '.verification');
const report = {
  status: 'running', checks: [], errors: [], requests: [], screenshots: [],
  scope: 'Actual production Electron UI, preload and local IPC with real imported images, three temporary libraries and an isolated profile. Only native picker results, this test process’s in-memory clipboard and declared preference-write failures are substituted. No real library, OS clipboard, Trash or generation service is touched.'
};
let app, temporary, stage = 'preparing';
const saved = {
  zh: '  主体：窗边的虚构成年人物。  \n共同一行\n\n光线：清晨窗光。\n不要裁切。\n  结尾保留空格。  \n\n',
  en: '  Subject: A fictional adult by a window.  \nCommon line\n\nLighting: Morning window light.\nKeep the complete framing.\n  Preserve trailing spaces.  \n\n'
};
const current = {
  zh: '  主体：窗边的虚构成年人物。  \n共同一行\n\n光线：蓝调夜光。\n完整多行草稿。\n  结尾保留空格。  \n\n',
  en: '  Subject: A fictional adult by a window.  \nCommon line\n\nLighting: Blue-hour evening light.\nComplete multiline draft.\n  Preserve trailing spaces.  \n\n'
};

async function fixture(root, count) {
  const source = path.join(path.dirname(root), `${path.basename(root)}-source`), images = path.join(source, 'images');
  await fs.mkdir(images, { recursive: true });
  const records = [];
  for (let id = 1; id <= count; id++) {
    const filename = `${String(id).padStart(3, '0')}-plans.png`;
    await fs.copyFile(path.join(project, 'assets/images', id === 1 ? '001-natural-window.png' : '003-korean-fresh.png'), path.join(images, filename));
    records.push({ id, label: `Plans fixture ${id}`, label_cn: `方案参考 ${id}`, label_en: `Plan reference ${id}`, filename,
      prompt_cn: `主体：虚构成年人 ${id}。\n完整原始中文提示词。`, prompt_en: `Subject: A fictional adult ${id}.\nComplete original English prompt.` });
  }
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(records, null, 2) + '\n');
  const library = new LocalLibrary(), initial = await library.open(root);
  const plan = await prepareBatchImport({ imageDirectory: images, manifestPath, type: 'photo' });
  const state = await library.importBatch(plan, { expectedVersion: initial.revision, confirmed: true });
  expect(state.batch.imported).toBe(count);
  return source;
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
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-plans-ui-')));
    const rootA = path.join(temporary, 'library-a'), rootB = path.join(temporary, 'library-b');
    const rootEmpty = path.join(temporary, 'library-empty'), profile = path.join(temporary, 'profile');
    await Promise.all([rootA, rootB, rootEmpty, profile, output].map(directory => fs.mkdir(directory, { recursive: true })));
    const sourceA = await fixture(rootA, 2), sourceB = await fixture(rootB, 1);
    await new LocalLibrary().open(rootEmpty);
    const roots = [rootA, rootB, rootEmpty, sourceA, sourceB];
    const before = await Promise.all(roots.map(fingerprint));
    const scope = root => JSON.stringify(['local', '', root]);
    const plansKey = root => `portraitStudio.promptPlans.v1.${scope(root)}`;
    const draftsKey = root => `portraitStudio.creativeDrafts.v1.${scope(root)}`;
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: rootA, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    async function launch(count = 2) {
      app = await electron.launch({ executablePath: require('electron'), args: [project], env });
      const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('request', request => { if (/^https?:/u.test(request.url())) report.requests.push(request.url()); });
      page.on('response', response => {
        if (response.url().startsWith('portrait-media:') && response.status() >= 400) report.errors.push(`Media response ${response.status()}: ${response.url()}`);
      });
      await app.evaluate(({ clipboard, shell }) => {
        globalThis.__plansCopies = [];
        clipboard.writeText = value => { globalThis.__plansCopies.push(value); };
        clipboard.readText = () => globalThis.__plansCopies.at(-1) ?? '';
        shell.trashItem = () => { throw new Error('Plans unexpectedly touched system Trash'); };
        shell.openPath = () => { throw new Error('Plans unexpectedly opened an external image'); };
      });
      await expect(page.locator('.portrait-card')).toHaveCount(count); return page;
    }
    async function appearance(page, language, theme) {
      await page.locator('#settingsToggle').click();
      await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
      await page.locator(`#themeControl button[data-theme="${theme}"]`).click();
      await page.locator('#settingsPanel').press('Escape');
      await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    }
    async function openLab(page) {
      await page.locator('#openCreativeLab').click(); await expect(page.locator('#creativeLabDialog')).toBeVisible();
    }
    async function openPlans(page) {
      await page.locator('#labOpenPlans').click(); await expect(page.locator('#promptPlans')).toBeVisible();
    }
    async function closeLab(page, escape = false) {
      if (escape) await page.keyboard.press('Escape'); else await page.locator('#closeCreativeLab').click();
      await expect(page.locator('#creativeLabDialog')).toBeHidden();
    }
    async function back(page) { await page.locator('#plansBack').click(); await expect(page.locator('#labDraft')).toBeVisible(); }
    async function writeBilingual(page, value, finalLanguage = 'zh', theme = 'dark') {
      for (const language of ['zh', 'en']) {
        await appearance(page, language, theme); await openLab(page);
        await page.locator('#labDraft').fill(value[language]); await closeLab(page);
      }
      if (finalLanguage !== 'en') await appearance(page, finalLanguage, theme);
    }
    async function selectPlan(page, id) {
      await page.locator(`[data-plan-id="${id}"]`).click();
      await expect(page.locator('#promptPlans')).toHaveAttribute('data-selected-plan', id);
      await expect(page.locator(`[data-plan-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
    const planIDs = page => page.locator('[data-plan-id]').evaluateAll(elements => elements.map(element => element.dataset.planId));
    const readPreference = (page, key) => page.evaluate(key => localStorage.getItem(key), key);
    async function expectDrafts(page, root, value) {
      await expect.poll(async () => JSON.parse(await readPreference(page, draftsKey(root)) ?? '{}')).toEqual(value);
    }
    async function save(page, title, expectedCount) {
      const previous = await planIDs(page);
      await page.locator('#planTitle').fill(title); await page.locator('#planSave').click();
      await expect(page.locator('[data-plan-id]')).toHaveCount(expectedCount);
      const id = (await planIDs(page)).find(id => !previous.includes(id));
      expect(id).toBeTruthy(); await expect(page.locator('#promptPlans')).toHaveAttribute('data-selected-plan', id);
      return id;
    }
    async function copy(page, text, storageFailed = false) {
      await page.locator('#planCopy').click();
      await expect.poll(() => app.evaluate(() => globalThis.__plansCopies.at(-1))).toBe(text);
      await expect(page.locator('#planFeedback')).toBeVisible();
      if (!storageFailed) await expect(page.locator('#planFeedback')).toHaveAttribute('role', 'status');
    }
    async function screenshot(page, name) {
      await page.screenshot({ path: path.join(output, name) }); report.screenshots.push(name);
    }
    async function switchLibrary(page, root, count) {
      await page.locator('.portrait-image').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
      await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryConfigure').click();
      await expect(page.locator('.portrait-card')).toHaveCount(count);
    }

    let page = await launch();
    await page.evaluate(() => {
      localStorage.setItem('portraitStudio.uiLanguage', 'zh'); localStorage.setItem('portraitStudio.theme', 'dark');
      localStorage.setItem('portraitStudio.sidebarCollapsed', 'false');
    });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(2);
    stage = 'bilingual save';
    await openLab(page); await openPlans(page); await expect(page.locator('[data-plan-id]')).toHaveCount(0);
    await page.locator('#planTitle').fill('Empty draft must not be saved'); await expect(page.locator('#planSave')).toBeDisabled();
    await closeLab(page); await writeBilingual(page, saved);
    await openLab(page); await openPlans(page);
    await page.locator('#planTitle').fill('长'.repeat(81)); await page.locator('#planSave').click();
    await expect(page.locator('[data-plan-id]')).toHaveCount(0);
    await expect(page.locator('#planFeedback')).toHaveAttribute('data-feedback-key', 'plans.titleTooLong');
    await expect(page.locator('#planTitle')).toHaveValue('长'.repeat(81));
    const title = '窗光方案 <script>globalThis.__plansInjected=true</script>';
    const firstID = await save(page, title, 1);
    await expect(page.locator('#planPrompt')).toHaveText(saved.zh);
    expect(await page.locator('#planPrompt').textContent()).toBe(saved.zh);
    const duplicateID = await save(page, title, 2); expect(duplicateID).not.toBe(firstID);
    await selectPlan(page, firstID); await copy(page, saved.zh);
    expect(await page.evaluate(() => globalThis.__plansInjected)).toBeUndefined();
    await screenshot(page, 'plans-zh-dark.png'); await closeLab(page);
    report.checks.push('Named bilingual snapshots preserve every leading/trailing space, blank line and prompt character; identical titles create distinct snapshots; arbitrary title text is escaped and empty drafts cannot be saved');

    stage = 'search compare copy restore and undo';
    await writeBilingual(page, current, 'en', 'light'); await openLab(page); await openPlans(page);
    await page.locator('#planSearch').fill('morning window'); await expect(page.locator('[data-plan-id]')).toHaveCount(2);
    await page.locator('#planSearch').fill('完整不存在 owned no match'); await expect(page.locator('[data-plan-id]')).toHaveCount(0);
    await page.locator('#planSearch').fill('窗光方案'); await expect(page.locator('[data-plan-id]')).toHaveCount(2);
    await page.locator('#planSearch').fill(''); await selectPlan(page, firstID);
    expect(await page.locator('#planPrompt').textContent()).toBe(saved.en);
    await page.locator('#planCompare').click(); await expect(page.locator('#planDiff')).toBeVisible();
    await expect(page.locator('[data-plan-diff="removed"]')).toContainText(['Lighting: Morning window light.', 'Keep the complete framing.']);
    await expect(page.locator('[data-plan-diff="added"]')).toContainText(['Lighting: Blue-hour evening light.', 'Complete multiline draft.']);
    await expect(page.locator('[data-plan-diff="same"]')).toContainText(['Common line']);
    const difference = await page.locator('[data-plan-diff]').evaluateAll(lines => lines.map(line => ({ type: line.dataset.planDiff, text: line.textContent })));
    expect(difference.filter(line => line.type !== 'added').map(line => line.text).join('')).toBe(saved.en);
    expect(difference.filter(line => line.type !== 'removed').map(line => line.text).join('')).toBe(current.en);
    await copy(page, saved.en);
    const copies = await app.evaluate(() => globalThis.__plansCopies.length);
    await app.evaluate(({ clipboard }) => {
      globalThis.__plansOriginalCopy = clipboard.writeText;
      clipboard.writeText = () => { throw new Error('Owned clipboard failure'); };
    });
    await page.locator('#planCopy').click(); await expect(page.locator('#planFeedback')).toHaveAttribute('role', 'alert');
    expect(await app.evaluate(() => globalThis.__plansCopies.length)).toBe(copies);
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.__plansOriginalCopy; }); await copy(page, saved.en);
    await screenshot(page, 'plans-compare-en-light.png');
    await page.locator('#planRestore').click(); await expect(page.locator('#planFeedback')).toHaveAttribute('data-feedback-key', 'plans.restored');
    await expectDrafts(page, rootA, saved); await back(page); await expect(page.locator('#labDraft')).toHaveValue(saved.en);
    await page.locator('#labUndo').click(); await expect(page.locator('#labDraft')).toHaveValue(current.en);
    await expectDrafts(page, rootA, current);
    report.checks.push('Search finds names and either-language prompt text; comparison marks saved lines as removed and current lines as added; exact native copy reports both success and failure; restore changes both drafts atomically and one undo restores both previous drafts');

    stage = 'rename delete and viewport';
    await openPlans(page); await selectPlan(page, firstID);
    await page.locator('#planRenameTitle').fill('N'.repeat(81)); await page.locator('#planRename').click();
    await expect(page.locator('#planFeedback')).toHaveAttribute('data-feedback-key', 'plans.titleTooLong');
    await expect(page.locator('#planSelectedTitle')).toHaveText(title);
    await page.locator('#planRenameTitle').fill('Window light · retained bilingual snapshot');
    await page.locator('#planRename').click(); await expect(page.locator('#planSelectedTitle')).toHaveText('Window light · retained bilingual snapshot');
    await selectPlan(page, duplicateID); await page.locator('#planDelete').click();
    await expect(page.locator('#planDeleteConfirm')).toBeVisible(); await expect(page.locator('[data-plan-id]')).toHaveCount(2);
    await page.locator('#planDeleteCancel').click(); await expect(page.locator('[data-plan-id]')).toHaveCount(2);
    await page.locator('#planDelete').click(); await page.locator('#planDeleteConfirm').click();
    await expect(page.locator('[data-plan-id]')).toHaveCount(1); await selectPlan(page, firstID);
    await page.setViewportSize({ width: 1080, height: 720 });
    const rect = await page.locator('#creativeLabDialog').boundingBox();
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1080); expect(rect.y + rect.height).toBeLessThanOrEqual(720);
    await expect(page.locator('#closeCreativeLab')).toBeInViewport(); await expect(page.locator('#plansBack')).toBeInViewport();
    await expect(page.locator('#planCopy')).toBeInViewport(); await screenshot(page, 'plans-en-light-1080x720.png');
    await page.setViewportSize({ width: 1440, height: 920 }); await closeLab(page, true);
    await app.close(); app = null; page = await launch(); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(1); await selectPlan(page, firstID);
    await expect(page.locator('#planSelectedTitle')).toHaveText('Window light · retained bilingual snapshot');
    expect(await page.locator('#planPrompt').textContent()).toBe(saved.en); await closeLab(page);
    report.checks.push('Rename retains prompt content; delete requires confirmation and cancel preserves the snapshot; a real Electron restart retains snapshot IDs, titles and bilingual text; both languages/themes render, and the English/light layout fits 1080×720 with close/back/copy controls visible');

    stage = 'library isolation';
    await appearance(page, 'zh', 'dark'); await switchLibrary(page, rootB, 1); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(0); await back(page);
    const other = { zh: '另一个图库的完整草稿。\n尾行。', en: '' };
    await page.locator('#labDraft').fill(other.zh); await openPlans(page); const otherID = await save(page, '图库 B 独立方案', 1);
    await closeLab(page); const storedB = await readPreference(page, plansKey(rootB));
    await appearance(page, 'en', 'light'); await openLab(page); await openPlans(page); await selectPlan(page, otherID);
    await expect(page.locator('#planCopy')).toBeDisabled(); await expect(page.locator('#planRestore')).toBeEnabled();
    await closeLab(page); await appearance(page, 'zh', 'dark');
    await switchLibrary(page, rootA, 2); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(1); await selectPlan(page, firstID);
    expect(await planIDs(page)).not.toContain(otherID); expect(await page.locator('#planPrompt').textContent()).toBe(saved.zh);
    await closeLab(page); expect(await readPreference(page, plansKey(rootB))).toBe(storedB);
    report.checks.push('Plan storage is isolated by library even when image IDs overlap; switching back restores the original snapshots and leaves the other library’s saved plans unchanged');

    stage = 'failed storage and recovery';
    const storedA = await readPreference(page, plansKey(rootA));
    await page.evaluate(() => {
      globalThis.__plansSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('portraitStudio.promptPlans.')) throw new DOMException('Owned plans quota test', 'QuotaExceededError');
        return globalThis.__plansSetItem.call(this, key, value);
      };
    });
    await openLab(page); await page.locator('#labDraft').fill('仅此会话方案。\n仍可复制与恢复。'); await openPlans(page);
    const sessionID = await save(page, '会话中的方案', 2);
    await expect(page.locator('#plansStorageWarning')).toBeVisible();
    await expect(page.locator('#plansStorageWarning')).toHaveAttribute('role', 'alert');
    expect(await readPreference(page, plansKey(rootA))).toBe(storedA);
    await copy(page, '仅此会话方案。\n仍可复制与恢复。', true); await closeLab(page); await openLab(page); await openPlans(page);
    expect(await planIDs(page)).toContain(sessionID); await closeLab(page);
    await switchLibrary(page, rootB, 1); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(1); await closeLab(page);
    await switchLibrary(page, rootA, 2); await openLab(page); await openPlans(page);
    expect(await planIDs(page)).toContain(sessionID); await expect(page.locator('#plansStorageWarning')).toBeVisible(); await closeLab(page);
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(2); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(1); expect(await planIDs(page)).not.toContain(sessionID);
    await closeLab(page); await page.evaluate(key => localStorage.setItem(key, '{owned malformed JSON'), plansKey(rootA));
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(2); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(0); await closeLab(page);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: plansKey(rootA), value: storedA });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(2); await openLab(page); await openPlans(page);
    await expect(page.locator('[data-plan-id]')).toHaveCount(1); await closeLab(page);
    expect(await readPreference(page, plansKey(rootB))).toBe(storedB);
    report.checks.push('Failed preference writes retain usable session snapshots with inline feedback, preserve the last disk state, and recover on reload; malformed JSON opens an empty collection without breaking the app or the other library’s plans');

    stage = 'long prompts and library without images';
    await switchLibrary(page, rootEmpty, 0);
    const maximum = { zh: '中'.repeat(65534) + '\n末', en: 'L'.repeat(65534) + '\nE' };
    await writeBilingual(page, maximum, 'zh'); await openLab(page); await openPlans(page);
    const longID = await save(page, '长'.repeat(80), 1); expect(await page.locator('#planPrompt').textContent()).toBe(maximum.zh);
    await copy(page, maximum.zh); await closeLab(page);
    await appearance(page, 'en', 'light'); await openLab(page); await openPlans(page); await selectPlan(page, longID);
    expect(await page.locator('#planPrompt').textContent()).toBe(maximum.en); await copy(page, maximum.en); await back(page);
    await page.locator('#labDraft').fill('Changed long English draft'); await openPlans(page); await selectPlan(page, longID);
    await page.locator('#planRestore').click(); await expectDrafts(page, rootEmpty, maximum);
    await back(page); await expect(page.locator('#labDraft')).toHaveValue(maximum.en); await closeLab(page);
    report.checks.push('A configured empty library supports plans without reference images; 80-character titles and full 65,536-character Chinese/English prompt snapshots save, copy and restore without truncation');

    stage = 'capacity and explicit space recovery';
    await writeBilingual(page, { zh: '容量测试草稿。', en: 'Small capacity-test draft' }, 'en', 'light');
    await openLab(page); await openPlans(page);
    for (let count = 2; count <= 30; count++) await save(page, `Owned capacity ${count}`, count);
    await page.locator('#planTitle').fill('Thirty-first plan must be rejected');
    if (await page.locator('#planSave').isEnabled()) await page.locator('#planSave').click();
    await expect(page.locator('[data-plan-id]')).toHaveCount(30);
    expect(await planIDs(page)).toContain(longID);
    await page.locator('#planDelete').click(); await page.locator('#planDeleteConfirm').click();
    await expect(page.locator('[data-plan-id]')).toHaveCount(29); await save(page, 'Space recovered explicitly', 30); await back(page);
    await expect(page.locator('#labDraft')).toHaveValue('Small capacity-test draft'); await closeLab(page);
    report.checks.push('The 30-plan capacity never evicts an existing snapshot; explicit deletion releases space and permits a new save without altering the current draft');

    expect(await Promise.all(roots.map(fingerprint))).toEqual(before);
    expect(report.errors).toEqual([]); expect(report.requests).toEqual([]);
    report.checks.push('All source-image, library-index, prompt and archive bytes remain unchanged; no page exceptions, failed media responses or HTTP generation/network requests occur');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.stage = stage; report.failure = error.message;
    if (app) {
      const page = await app.firstWindow();
      report.visibleState = await page.evaluate(() => ({
        dialogs: [...document.querySelectorAll('dialog')].map(dialog => ({ id: dialog.id, open: dialog.open })),
        plans: document.querySelector('#promptPlans')?.outerHTML?.slice(0, 10000),
        draft: document.querySelector('#labDraft')?.value?.slice(0, 300)
      })).catch(() => null);
      await screenshotFallback(page);
    }
    throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'plans-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, stage, checks: report.checks.length, errors: report.errors, requests: report.requests, report: path.join(output, 'plans-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function screenshotFallback(page) {
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'plans-failure.png') }).catch(() => {});
}
