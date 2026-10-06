'use strict';

// Production Electron/React/preload/local IPC with owned fixtures and profile.
// Only native picker results and this test process's clipboard are substituted.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { LocalLibrary } = require('../local-library.cjs');
const { prepareBatchImport } = require('../batch-import.cjs');
const messages = require('../src/ui-messages.json');
const project = path.resolve(__dirname, '..'), output = path.join(project, '.verification');
const report = {
  status: 'running', checks: [], errors: [], requests: [],
  scope: 'Actual production Electron UI, preload and local IPC with bilingual imported prompts, three temporary libraries and an isolated profile. No real library, system clipboard, Trash or generation services are touched.'
};
let app, temporary;

const prompts = {
  1: {
    zh: '主体：一位28岁的虚构成年人。\n保持面部细节。\n\n光线：柔和的北向窗光。\n保留自然皮肤质感。\n\n构图：半身肖像，50毫米镜头。\n不要拼贴、文字或水印。',
    en: 'Subject: One fictional adult portrait, age 28.\nKeep facial details consistent.\n\nLighting: Soft northern window light.\nPreserve natural skin texture.\n\nComposition: Half-length portrait, 50 mm lens.\nNo montage, words or watermark.'
  },
  2: {
    zh: '雨水柔化城市的边缘。\n人物站在暖色灯光下，保持整段叙述完整。\n\n长焦压缩背景，湿润的石板反射微光。\n保留换行、标点与这一行结尾。',
    en: 'Rainfall softens the city edges.\nThe adult subject stands under warm street lights; keep the full narrative.\n\nA long lens compresses the backdrop, with wet pavement reflecting faint light.\nKeep every newline, punctuation mark and this final line.'
  },
  3: { zh: '主体：山间旅行者。\n氛围：清晨的安静。', en: 'Subject: An adult mountain traveler.\nMood: A quiet morning.' },
  4: { zh: '场景：银灰色工作室。\n构图：留出呼吸空间。', en: 'Scene: A silver-gray studio.\nComposition: Leave breathing room.' },
  5: { zh: '主体：' + '长'.repeat(65520), en: 'Subject: ' + 'L'.repeat(65520) }
};
const lightingText = {
  zh: '光线：柔和的北向窗光。\n保留自然皮肤质感。\n',
  en: 'Lighting: Soft northern window light.\nPreserve natural skin texture.\n'
};

async function fixture(root, entries) {
  const source = path.join(path.dirname(root), `${path.basename(root)}-source`), images = path.join(source, 'images');
  await fs.mkdir(images, { recursive: true });
  const records = [];
  for (const [id, zh, en, original] of entries) {
    const filename = `${String(id).padStart(3, '0')}-creative.png`;
    await fs.copyFile(path.join(project, 'assets/images', original), path.join(images, filename));
    records.push({ id, label: `Creative fixture ${id}`, label_cn: zh, label_en: en, filename,
      prompt_cn: prompts[id].zh, prompt_en: prompts[id].en });
  }
  const manifestPath = path.join(source, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(records, null, 2) + '\n');
  const library = new LocalLibrary(), initial = await library.open(root);
  const plan = await prepareBatchImport({ imageDirectory: images, manifestPath, type: 'photo' });
  const snapshot = await library.importBatch(plan, { expectedVersion: initial.revision, confirmed: true });
  expect(snapshot.batch.imported).toBe(entries.length);
  return snapshot;
}

async function fingerprint(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
      if (['.portrait-studio/lock.json', '.portrait-studio/lock-reclaim.json'].includes(relative)) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files[relative] = crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
      else throw new Error(`Unexpected fixture file type: ${relative}`);
    }
  }
  await visit(root); return files;
}

(async () => {
  try {
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-creative-ui-')));
    const rootA = path.join(temporary, 'library-a'), rootB = path.join(temporary, 'library-b'), rootEmpty = path.join(temporary, 'library-empty');
    const profile = path.join(temporary, 'profile');
    await Promise.all([rootA, rootB, rootEmpty, profile, output].map(directory => fs.mkdir(directory, { recursive: true })));
    await fixture(rootA, [
      [1, '窗光肖像', 'Window-light portrait', '001-natural-window.png'],
      [2, '雨夜叙事', 'Rainy-night narrative', '031-rainy-night.png'],
      [3, '山间旅行', 'Mountain traveler', '033-autumn-forest.png'],
      [4, '银灰工作室', 'Silver-gray studio', '013-scandinavian-minimal.png'],
      [5, '完整长提示词', 'Complete long prompt', '012-italian-luxury.png']
    ]);
    await fixture(rootB, [[1, '另一个窗光', 'Other window light', '003-korean-fresh.png'], [2, '另一个雨夜', 'Other rainy night', '043-renaissance.png']]);
    await new LocalLibrary().open(rootEmpty);
    const beforeA = await fingerprint(rootA), beforeB = await fingerprint(rootB), beforeEmpty = await fingerprint(rootEmpty);
    const draftKey = root => `portraitStudio.creativeDrafts.v1.${JSON.stringify(['local', '', root])}`;
    const keyA = draftKey(rootA), keyB = draftKey(rootB), keyEmpty = draftKey(rootEmpty);
    const env = { ...process.env, PORTRAIT_STUDIO_BACKEND: 'local', PORTRAIT_STUDIO_LIBRARY_DIR: rootA, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const source = (page, id) => page.locator(`[data-lab-source="${id}"]`);
    const block = (page, id, language, index) => page.locator(`input[data-lab-block="${id}:${language}:${index}"]`);
    const readPreference = (page, key) => page.evaluate(key => localStorage.getItem(key), key);
    const readDrafts = async (page, key) => JSON.parse(await readPreference(page, key) ?? '{}');
    const message = (language, key) => messages[language][key].replaceAll('{max}', '65536').replaceAll('{count}', '4');
    const labSearches = new WeakMap();
    async function decode(page) {
      await page.evaluate(() => Promise.all([...document.querySelectorAll('.portrait-image')].map(image => image.decode())));
    }
    async function launch() {
      app = await electron.launch({ executablePath: require('electron'), args: [project], env });
      const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 920 });
      page.on('pageerror', error => report.errors.push(error.message));
      page.on('request', request => { if (/^https?:/u.test(request.url())) report.requests.push(request.url()); });
      await app.evaluate(({ clipboard }) => { globalThis.__creativeCopies = []; clipboard.writeText = value => globalThis.__creativeCopies.push(value); });
      await expect(page.locator('.portrait-card')).toHaveCount(5); await decode(page);
      return page;
    }
    async function openLab(page, empty = false) {
      if (empty) {
        labSearches.set(page, await page.locator('#searchInput').inputValue());
        await page.locator('#searchInput').fill('creative-owned-no-match-9c450d9c');
        await expect(page.locator('.portrait-card')).toHaveCount(0);
      }
      await page.locator('#openCreativeLab').click(); await expect(page.locator('#creativeLabDialog')).toBeVisible();
    }
    async function closeLab(page, escape = false) {
      if (escape) await page.keyboard.press('Escape'); else await page.locator('#closeCreativeLab').click();
      await expect(page.locator('#creativeLabDialog')).toBeHidden();
      if (labSearches.has(page)) {
        await page.locator('#searchInput').fill(labSearches.get(page)); labSearches.delete(page);
      }
    }
    async function addSource(page, id, count) {
      await page.locator('#labSourceSelect').selectOption(String(id)); await page.locator('#labAddSource').click();
      await expect(page.locator('[data-lab-source]')).toHaveCount(count); await expect(source(page, id)).toBeVisible();
    }
    async function selectOnly(page, keys) {
      const inputs = page.locator('input[data-lab-block]');
      for (let index = 0; index < await inputs.count(); index++) await inputs.nth(index).uncheck();
      for (const key of keys) await page.locator(`input[data-lab-block="${key}"]`).check();
    }
    async function setAppearance(page, language, theme) {
      await page.locator('#settingsToggle').click(); await page.locator(`#uiLanguage button[data-language="${language}"]`).click();
      await page.locator(`#themeControl button[data-theme="${theme}"]`).click(); await page.locator('#settingsPanel').press('Escape');
    }
    async function switchLibrary(page, root, count) {
      await decode(page);
      await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
      await page.locator('#libraryMenuToggle').click(); await page.locator('#libraryConfigure').click();
      await expect(page.locator('.portrait-card')).toHaveCount(count); await expect(page.locator('#compareTray')).toHaveCount(0);
    }
    async function externalWrite(page, action) {
      await decode(page);
      await expect.poll(async () => {
        try { await action(); return 'done'; }
        catch (error) { if (error.code !== 'LIBRARY_BUSY') throw error; return 'busy'; }
      }, { timeout: 10000, intervals: [100, 250, 500] }).toBe('done');
    }
    async function directions(page) {
      return Promise.all(['lighting', 'composition', 'mood'].map(category => page.locator(`[data-lab-direction="${category}"]`).textContent()));
    }
    async function copyDraft(page, expected) {
      await page.locator('#labCopyDraft').click();
      await expect.poll(() => app.evaluate(() => globalThis.__creativeCopies.at(-1))).toBe(expected);
      await expect(page.locator('#labCopyStatus')).toBeVisible(); await expect(page.locator('#labCopyStatus')).toHaveAttribute('role', 'status');
    }

    let page = await launch();
    await page.evaluate(() => {
      localStorage.setItem('portraitStudio.uiLanguage', 'zh'); localStorage.setItem('portraitStudio.theme', 'dark');
      localStorage.setItem('portraitStudio.sidebarCollapsed', 'false');
    });
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(5);
    await page.locator('.portrait-card[data-id="1"]').click(); await expect(page.locator('#detailDialog')).toBeVisible();
    await page.locator('#detailCreativeLab').click(); await expect(page.locator('#creativeLabDialog')).toBeVisible();
    await expect(page.locator('#detailDialog')).toBeHidden(); await expect(page.locator('[data-lab-source]')).toHaveCount(1);
    await expect(source(page, 1)).toContainText('窗光肖像'); await expect(page.locator('#labDraft')).toHaveValue('');
    const manual = '我的手动草稿。\n保留完整文本：<script>globalThis.__creativeInjected = true</script>。';
    await page.locator('#labDraft').fill(manual); await addSource(page, 2, 2);
    await expect(source(page, 2).locator('input[data-lab-block]')).toHaveCount(1);
    await selectOnly(page, ['1:zh:1']); await expect(page.locator('#labDraft')).toHaveValue(manual);
    await page.locator('#labCompose').click(); await expect(page.locator('#labDraft')).toHaveValue(lightingText.zh);
    await block(page, 2, 'zh', 0).check(); await expect(page.locator('#labDraft')).toHaveValue(lightingText.zh);
    await page.locator('#labCompose').click();
    const mixedZh = lightingText.zh + '\n' + prompts[2].zh;
    await expect(page.locator('#labDraft')).toHaveValue(mixedZh);
    await expect(page.locator('#labDraft')).not.toHaveValue(prompts[1].zh);
    await copyDraft(page, mixedZh);
    const copiesBeforeFault = await app.evaluate(() => globalThis.__creativeCopies.length);
    await app.evaluate(({ clipboard }) => {
      globalThis.__creativeCopyCapture = clipboard.writeText;
      clipboard.writeText = () => { throw new Error('Owned clipboard failure test'); };
    });
    await page.locator('#labCopyDraft').click(); await expect(page.locator('#labError')).toHaveText(messages.zh['lab.copyFailed']);
    await expect(page.locator('#labError')).toBeVisible(); await expect(page.locator('#labDraft')).toHaveValue(mixedZh);
    expect(await app.evaluate(() => globalThis.__creativeCopies.length)).toBe(copiesBeforeFault);
    await app.evaluate(({ clipboard }) => { clipboard.writeText = globalThis.__creativeCopyCapture; });
    await copyDraft(page, mixedZh); await page.locator('#labUndo').click();
    await expect(page.locator('#labDraft')).toHaveValue(lightingText.zh);
    await page.locator('#labDraft').fill(manual); await page.locator('#labCompose').click();
    await expect(page.locator('#labDraft')).toHaveValue(mixedZh); await page.locator('#labUndo').click();
    await expect(page.locator('#labDraft')).toHaveValue(manual);
    expect(await page.evaluate(() => globalThis.__creativeInjected)).toBeUndefined();
    report.checks.push('Detail entry seeds its source; bilingual labeled blocks and freeform paragraphs remain complete, composition is explicit, manual editing survives source/selection changes, undo restores the prior draft, and native copy preserves exact text with visible success/failure feedback');

    const initialDice = await directions(page);
    await page.locator('[data-lab-lock="lighting"]').click();
    await expect(page.locator('[data-lab-lock="lighting"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#labRollDice').click(); const rolled = await directions(page);
    expect(rolled[0]).toBe(initialDice[0]); expect(rolled[1]).not.toBe(initialDice[1]); expect(rolled[2]).not.toBe(initialDice[2]);
    await expect(page.locator('#labDraft')).toHaveValue(manual);
    await page.locator('[data-lab-lock="composition"]').click(); await page.locator('[data-lab-lock="mood"]').click();
    if (await page.locator('#labRollDice').isEnabled()) await page.locator('#labRollDice').click();
    expect(await directions(page)).toEqual(rolled);
    for (const category of ['lighting', 'composition', 'mood']) await page.locator(`[data-lab-lock="${category}"]`).click();
    await page.locator('#labAppendDice').click(); const withDice = await page.locator('#labDraft').inputValue();
    expect(withDice.startsWith(manual + '\n')).toBe(true);
    for (const direction of rolled) expect(withDice).toContain(direction);
    await copyDraft(page, withDice); await page.locator('#labUndo').click(); await expect(page.locator('#labDraft')).toHaveValue(manual);
    await addSource(page, 3, 3); await addSource(page, 4, 4);
    await expect(page.locator('#labAddSource')).toBeDisabled(); await expect(page.locator('#labDraft')).toHaveValue(manual);
    await source(page, 3).locator('[data-lab-remove-source]').click(); await expect(page.locator('[data-lab-source]')).toHaveCount(3);
    await expect(page.locator('#labDraft')).toHaveValue(manual); await addSource(page, 5, 4);
    await selectOnly(page, ['1:zh:0', '5:zh:0']); await page.locator('#labCompose').click();
    await expect(page.locator('#labError')).toHaveText(message('zh', 'lab.tooLong')); await expect(page.locator('#labDraft')).toHaveValue(manual);
    const maximum = 'D'.repeat(65536); await page.locator('#labDraft').fill(maximum); await page.locator('#labAppendDice').click();
    await expect(page.locator('#labError')).toHaveText(message('zh', 'lab.tooLong')); await expect(page.locator('#labDraft')).toHaveValue(maximum);
    await page.locator('#labDraft').fill(manual); await source(page, 5).locator('[data-lab-remove-source]').click();
    await source(page, 4).locator('[data-lab-remove-source]').click(); await selectOnly(page, ['1:zh:1', '2:zh:0']);
    await page.locator('#labCompose').click(); await expect(page.locator('#labDraft')).toHaveValue(mixedZh);
    await page.screenshot({ path: path.join(output, 'creative-zh-dark.png') });
    await closeLab(page, true); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue(mixedZh);
    await expect(page.locator('[data-lab-source]')).toHaveCount(3);
    const randomSources = await page.locator('[data-lab-source]').evaluateAll(sources => sources.map(source => source.dataset.labSource));
    expect(new Set(randomSources).size).toBe(3); await closeLab(page);
    expect(await fingerprint(rootA)).toEqual(beforeA); expect(await fingerprint(rootB)).toEqual(beforeB);
    report.checks.push('Dice respect locks, avoid immediate repeats, and append complete directions only on request; four-source cap, removal, oversize compose/append rejection and Escape preserve drafts without changing any library bytes');

    await page.locator('.portrait-card[data-id="1"] .compare-button').click(); await page.locator('.portrait-card[data-id="2"] .compare-button').click();
    await page.locator('#openComparison').click(); await expect(page.locator('#compareDialog')).toBeVisible();
    const writer = new LocalLibrary(); let latest;
    await externalWrite(page, async () => {
      const snapshot = await writer.open(rootA), item = snapshot.items.find(item => item.id === 1);
      latest = await writer.update({ id: 1, label: item.label, type: item.type,
        prompts: { zh: item.prompts.zh.replace('保持面部细节。', '保持面部细节。\n外部进程新增的最新中文内容。'), en: item.prompts.en.replace('Keep facial details consistent.', 'Keep facial details consistent.\nNewest English content from an external writer.') },
        expectedVersion: snapshot.revision, expectedRevision: item.revision });
    });
    await page.locator('#compareCreativeLab').click(); await expect(page.locator('#creativeLabDialog')).toBeVisible();
    await expect(page.locator('#compareDialog')).toBeHidden(); await expect(page.locator('[data-lab-source]')).toHaveCount(2);
    await expect(source(page, 1)).toContainText('外部进程新增的最新中文内容。');
    await selectOnly(page, ['1:zh:0']); await page.locator('#labCompose').click();
    const latestZh = await page.locator('#labDraft').inputValue(); expect(latestZh).toContain('外部进程新增的最新中文内容。');
    await copyDraft(page, latestZh); await closeLab(page);
    const afterUpdateA = await fingerprint(rootA);
    report.checks.push('Opening the lab from an already-open comparison refreshes authoritative records and uses/copies an external writer’s latest full prompt blocks');

    await setAppearance(page, 'en', 'light'); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue('');
    if (!await source(page, 1).count()) await addSource(page, 1, 1);
    if (!await source(page, 2).count()) await addSource(page, 2, 2);
    await expect(source(page, 1)).toContainText('Window-light portrait');
    await selectOnly(page, ['1:en:1', '2:en:0']); await page.locator('#labCompose').click();
    const mixedEn = lightingText.en + '\n' + prompts[2].en;
    await expect(page.locator('#labDraft')).toHaveValue(mixedEn); await copyDraft(page, mixedEn);
    await page.screenshot({ path: path.join(output, 'creative-en-light.png') });
    await page.setViewportSize({ width: 1080, height: 720 });
    const bounds = await page.locator('#creativeLabDialog').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1080); expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
    await expect(page.locator('#closeCreativeLab')).toBeInViewport(); await expect(page.locator('#labCopyDraft')).toBeInViewport();
    await page.screenshot({ path: path.join(output, 'creative-en-light-1080x720.png') });
    await page.setViewportSize({ width: 1440, height: 920 }); await closeLab(page);
    await setAppearance(page, 'zh', 'dark'); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue(latestZh); await closeLab(page);
    await expect.poll(async () => (await readDrafts(page, keyA)).zh).toBe(latestZh);
    expect((await readDrafts(page, keyA)).en).toBe(mixedEn);
    await app.close(); app = null; page = await launch();
    await openLab(page, true); await expect(page.locator('#labDraft')).toHaveValue(latestZh);
    await expect(page.locator('[data-lab-source]')).toHaveCount(0); await closeLab(page);
    await setAppearance(page, 'en', 'light'); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue(mixedEn); await closeLab(page);
    report.checks.push('Chinese and English drafts are independent and persist across close/reopen, language changes and an actual Electron restart; both themes render cleanly and the 1080×720 dialog keeps close/copy controls visible');

    await setAppearance(page, 'zh', 'dark'); await switchLibrary(page, rootB, 2); await openLab(page, true);
    await expect(page.locator('[data-lab-source]')).toHaveCount(0); await expect(page.locator('#labDraft')).toHaveValue('');
    const otherDraft = '图库 B 的独立中文草稿。'; await page.locator('#labDraft').fill(otherDraft); await addSource(page, 1, 1);
    await closeLab(page); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue(otherDraft); await closeLab(page);
    const storedB = await readPreference(page, keyB); await switchLibrary(page, rootA, 5); await openLab(page, true);
    await expect(page.locator('[data-lab-source]')).toHaveCount(0); await expect(page.locator('#labDraft')).toHaveValue(latestZh); await closeLab(page);
    const storedA = await readPreference(page, keyA);
    await page.evaluate(() => {
      globalThis.__creativeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('portraitStudio.creativeDrafts.')) throw new DOMException('Owned quota test', 'QuotaExceededError');
        return globalThis.__creativeSetItem.call(this, key, value);
      };
    });
    await openLab(page); const session = '仅本次会话保留的完整草稿。'; await page.locator('#labDraft').fill(session);
    await expect(page.locator('#toastMessage')).toHaveText(messages.zh['lab.sessionOnly']); await expect(page.locator('#toast')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#labError')).toHaveText(messages.zh['lab.sessionOnly']); await expect(page.locator('#labError')).toBeVisible();
    expect(await readPreference(page, keyA)).toBe(storedA); await closeLab(page); await openLab(page);
    await expect(page.locator('#labDraft')).toHaveValue(session); await closeLab(page);
    await page.reload(); await expect(page.locator('.portrait-card')).toHaveCount(5); await openLab(page);
    await expect(page.locator('#labDraft')).toHaveValue(latestZh); await closeLab(page);
    await page.evaluate(key => localStorage.setItem(key, '{broken-json'), keyA); await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(5); await openLab(page, true);
    await expect(page.locator('#labDraft')).toHaveValue(''); await expect(page.locator('[data-lab-source]')).toHaveCount(0); await closeLab(page);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: keyA, value: storedA }); await page.reload();
    await expect(page.locator('.portrait-card')).toHaveCount(5); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue(latestZh); await closeLab(page);
    expect(await readPreference(page, keyB)).toBe(storedB);
    report.checks.push('Switching libraries isolates bilingual drafts even for overlapping image IDs and clears sources; failed preference writes keep session text and notify, while corrupted JSON recovers without affecting the other library');

    await switchLibrary(page, rootEmpty, 0); await expect(page.locator('#openCreativeLab')).toBeEnabled(); await openLab(page);
    await expect(page.locator('[data-lab-source]')).toHaveCount(0); await expect(page.locator('#labCompose')).toBeDisabled();
    await page.locator('#labRollDice').click(); const emptyDirections = await directions(page);
    await page.locator('#labAppendDice').click(); const diceOnly = await page.locator('#labDraft').inputValue();
    for (const direction of emptyDirections) expect(diceOnly).toContain(direction);
    await copyDraft(page, diceOnly); await closeLab(page); await openLab(page); await expect(page.locator('#labDraft')).toHaveValue(diceOnly); await closeLab(page);
    await expect.poll(async () => (await readDrafts(page, keyEmpty)).zh).toBe(diceOnly);
    expect(await fingerprint(rootA)).toEqual(afterUpdateA); expect(await fingerprint(rootB)).toEqual(beforeB); expect(await fingerprint(rootEmpty)).toEqual(beforeEmpty);
    expect(await readPreference(page, keyB)).toBe(storedB);
    expect(report.errors).toEqual([]); expect(report.requests).toEqual([]);
    report.checks.push('A configured empty library supports standalone direction dice and exact native draft copy/persistence; all source/image/index/archive bytes remain unchanged except the explicit owned external update, and no generation/network request occurs');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.message;
    if (app) {
      const page = await app.firstWindow();
      report.geometry = await page.evaluate(() => [...document.querySelectorAll('[data-lab-remove-source]')].map(button => {
        const rect = button.getBoundingClientRect(), parent = button.closest('.lab-source-list');
        const hit = (x, y) => { const target = document.elementFromPoint(x, y); return target ? { tag: target.tagName, className: target.className } : null; };
        return { id: button.dataset.labRemoveSource, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          center: hit(rect.x + rect.width / 2, rect.y + rect.height / 2), left: hit(rect.x + 4, rect.y + rect.height / 2),
          parent: parent ? { clientWidth: parent.clientWidth, offsetWidth: parent.offsetWidth, scrollWidth: parent.scrollWidth } : null };
      })).catch(() => []);
      await page.screenshot({ path: path.join(output, 'creative-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await app?.close();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'creative-ui.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, requests: report.requests, report: path.join(output, 'creative-ui.json') }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
