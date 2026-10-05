'use strict';
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const messages = require('../src/ui-messages.json');
const output = path.resolve(__dirname, '../.verification/local-react-ui.json');
const report = { status: 'running', scope: 'Actual production React components with an isolated in-memory local Electron bridge fixture. No real library, native picker, OS clipboard, Trash, server, or user profile is changed.', checks: [], errors: [], previewApiRequests: [] };
let browser;
(async () => {
  try {
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/__preview/api/')) report.previewApiRequests.push(request.url()); });
    await page.addInitScript(() => {
      if (location.origin !== 'http://127.0.0.1:5173') return;
      const params = new URL(location.href).searchParams;
      localStorage.setItem('portraitStudio.uiLanguage', params.get('lang') || 'zh');
      localStorage.setItem('portraitStudio.theme', 'dark');
      localStorage.setItem('portraitStudio.sidebarCollapsed', 'false');
      const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3l8AAAAASUVORK5CYII=';
      const item = { id: 1, revision: 1, label: 'Original fixture', type: 'photo', image: 'fixture.png', image_url: image, prompts: { en: 'Full English local fixture prompt with all details.', zh: '完整中文本地测试提示词，保留全部细节。' } };
      window.__localCalls = []; window.__localCopy = []; window.__localCodes = {};
      window.__localState = { configured: !params.has('unconfigured'), backend: 'local', remote: false, root: params.has('unconfigured') ? null : '/isolated-fixture/library', writable: !params.has('readonly') && !params.has('unconfigured'), revision: 1, items: params.has('unconfigured') ? [] : [item] };
      if (params.has('expired')) window.__localState.authentication = { kind: 'platform', username: 'admin', expiresAt: '2020-01-01T00:00:00Z' };
      const ok = data => ({ ok: true, data: structuredClone(data) });
      function operation(action, payload, callback) {
        window.__localCalls.push({ action, payload });
        return window.__localCodes[action] ? { ok: false, error: { code: window.__localCodes[action] } } : ok(callback());
      }
      function unsupported(action) { window.__localCalls.push({ action }); return { ok: false, error: { code: 'BACKEND_UNSUPPORTED' } }; }
      window.portraitStudio = {
        ...(params.has('legacy') ? {} : { backend: 'local' }), ...(params.has('browser') ? { mode: 'browser-preview' } : {}),
        setUILanguage: async locale => ok({ locale }),
        connectionSettings: async () => unsupported('remoteSettings'), saveConnection: async () => unsupported('remoteSave'), signIn: async () => unsupported('remoteSignIn'), logout: async () => unsupported('remoteLogout'),
        libraryList: async () => operation('list', undefined, () => window.__localState),
        libraryGet: async id => operation('get', id, () => ({ item: window.__localState.items.find(item => item.id === id) })),
        chooseLibrary: async () => operation('chooseLibrary', undefined, () => {
          if (window.__cancelChoose) return { cancelled: true };
          window.__localState = { ...window.__localState, configured: true, writable: true, root: '/isolated-fixture/selected-library' };
          return window.__localState;
        }),
        chooseImage: async () => operation('chooseImage', undefined, () => ({ token: 'local-selection', name: 'fixture.png', previewURL: image })),
        releaseImage: async token => operation('releaseImage', token, () => ({ released: true })),
        createPortrait: async payload => operation('createPortrait', payload, () => {
          window.__localState.revision++;
          window.__localState.items.push({ id: payload.id, revision: 1, label: payload.label, type: payload.type, prompts: payload.prompts, image: 'fixture.png', image_url: image });
          return window.__localState;
        }),
        updatePortrait: async payload => operation('updatePortrait', payload, () => {
          window.__localState.revision++;
          const current = window.__localState.items.find(item => item.id === payload.id);
          Object.assign(current, { label: payload.label, prompts: payload.prompts, revision: current.revision + 1 });
          return window.__localState;
        }),
        deletePortrait: async payload => operation('deletePortrait', payload, () => {
          window.__localState.revision++;
          window.__localState.items = window.__localState.items.filter(item => item.id !== payload.id);
          return window.__localState;
        }),
        deletePortraits: async payload => operation('deletePortraits', payload, () => {
          const deletedIds = payload.items.map(item => item.id);
          window.__localState.revision += deletedIds.length;
          window.__localState.items = window.__localState.items.filter(item => !deletedIds.includes(item.id));
          return { snapshot: window.__localState, report: { deletedIds, remainingIds: [], errorCode: null } };
        }),
        chooseBatchDirectory: async () => operation('chooseBatchDirectory', undefined, () => ({ selectionId: 'local-source-directory', path: '/isolated-fixture/source', imageCount: 1, manifests: [{ candidateId: 'local-manifest', relativePath: 'prompts.json', recordCount: 1 }] })),
        previewBatch: async payload => operation('previewBatch', payload, () => ({ previewId: 'local-preview', root: window.__localState.root, revision: window.__localState.revision, canImport: true, total: 1, matched: 1, importable: 1, skipped: 0, conflicts: 0, items: [{ id: 2, label: 'Batch fixture', status: 'importable', sourceFileName: 'fixture.png' }], issues: [], unpaired: [] })),
        commitBatch: async payload => operation('commitBatch', payload, () => {
          window.__localState.revision++;
          window.__localState.items.push({ ...item, id: 2, label: 'Batch fixture', prompts: { en: 'Complete batch English prompt', zh: '完整批量中文提示词' } });
          return { snapshot: window.__localState, report: { imported: 1, skipped: 0, conflicts: 0 } };
        }),
        cancelBatch: async payload => operation('cancelBatch', payload, () => ({ released: true })),
        copyPrompt: async value => {
          window.__localCalls.push({ action: 'copyPrompt', payload: value });
          const current = window.__localState.items.find(item => item.id === value.id);
          if (window.__localCodes.copyPrompt || !current || current.revision !== value.revision || !['zh', 'en'].includes(value.language)) return false;
          window.__localCopy.push(current.prompts[value.language]); return true;
        },
        copyText: async value => { window.__localCalls.push({ action: 'copyText' }); window.__localCopy.push(value); return true; },
        openImage: async value => { window.__localCalls.push({ action: 'openImage', payload: value }); return window.__openImageResult !== false; }
      };
    });
    async function load(locale = 'zh', suffix = '') {
      if (page.url().startsWith('http://127.0.0.1:5173/')) expect(await page.evaluate(() => window.__localCalls.filter(call => call.action.startsWith('remote')).length)).toBe(0);
      await page.goto(`http://127.0.0.1:5173/?lang=${locale}${suffix}`);
      await expect.poll(() => page.evaluate(() => window.__localCalls.filter(call => call.action === 'list').length)).toBe(1);
      await expect(page.locator('#remoteConnectionDialog')).toHaveCount(0);
    }
    async function menu() { await page.locator('#libraryMenuToggle').click(); }
    for (const locale of ['zh', 'en']) {
      await load(locale);
      await expect(page.locator('.portrait-card')).toHaveCount(1);
      await menu();
      await expect(page.locator('#libraryStatus')).toHaveText(messages[locale]['sidebar.editable']);
      await expect(page.locator('#libraryRoot')).toHaveText('/isolated-fixture/library');
      await expect(page.locator('#libraryCreate')).toBeEnabled(); await expect(page.locator('#libraryBatch')).toBeEnabled();
      await expect(page.locator('#libraryConfigure')).toHaveText(messages[locale]['sidebar.switch']);
      await menu();
      await page.locator('#settingsToggle').click();
      await expect(page.locator('#uiLanguage')).toBeVisible(); await expect(page.locator('#themeControl')).toBeVisible();
      await expect(page.locator('#settingsConnection')).toHaveCount(0);
      await expect(page.locator('#settingsLibraryRoot')).toHaveText('/isolated-fixture/library');
      await expect(page.locator('#settingsLibrary')).toBeEnabled();
      await page.evaluate(() => { window.__cancelChoose = true; });
      await page.locator('#settingsLibrary').click();
      await expect.poll(() => page.evaluate(() => window.__localCalls.filter(call => call.action === 'chooseLibrary').length)).toBe(1);
      await expect(page.locator('.portrait-card')).toHaveCount(1);
      await page.evaluate(() => { window.__cancelChoose = false; });
      await menu(); await page.locator('#libraryConfigure').click();
      await menu(); await expect(page.locator('#libraryRoot')).toHaveText('/isolated-fixture/selected-library'); await menu();
      report.checks.push({ locale, check: 'Configured local snapshot enables CRUD/batch without authentication; Settings shows language/theme/local path, and both path entries use chooseLibrary with cancellation preserving data' });
    }

    await load(); await menu(); await page.locator('#libraryCreate').click();
    await page.locator('#portraitChooseImage').click();
    await page.locator('#portraitLabel').fill('Created local fixture');
    await page.locator('#portraitPromptEn').fill('Complete created English prompt');
    await page.locator('#portraitPromptZh').fill('完整新建中文提示词');
    await page.evaluate(() => { window.__localCodes.createPortrait = 'INVALID_INPUT'; });
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitFormError')).toBeVisible();
    await expect(page.locator('#portraitPromptEn')).toHaveValue('Complete created English prompt');
    await expect(page.locator('#portraitPromptZh')).toHaveValue('完整新建中文提示词');
    await page.evaluate(() => { delete window.__localCodes.createPortrait; });
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitEditor')).toBeHidden(); await expect(page.locator('.portrait-card')).toHaveCount(2);
    const created = await page.evaluate(() => window.__localState.items.find(item => item.id === 2));
    expect(created.prompts).toEqual({ en: 'Complete created English prompt', zh: '完整新建中文提示词' });
    report.checks.push('Local image selection and create use fixed local bridge and preserve both full prompt drafts across ordinary validation failure');

    await page.locator('.portrait-card[data-id="2"]').click(); await page.locator('#detailEdit').click();
    await page.locator('#portraitLabel').fill('Edited local fixture');
    await page.locator('#portraitPromptZh').fill('完整编辑中文提示词');
    await page.locator('#portraitSave').click(); await expect(page.locator('#portraitEditor')).toBeHidden();
    const edited = await page.evaluate(() => window.__localState.items.find(item => item.id === 2));
    expect(edited.label).toBe('Edited local fixture'); expect(edited.prompts).toEqual({ en: 'Complete created English prompt', zh: '完整编辑中文提示词' });
    await page.locator('#detailDelete').click();
    await expect(page.locator('#deleteConfirmTitle')).toHaveText(messages.zh['delete.title']);
    await expect(page.locator('#deleteConfirmDialog')).toContainText('macOS');
    await page.locator('#deleteConfirm').click(); await expect(page.locator('.portrait-card')).toHaveCount(1);
    expect(await page.evaluate(() => window.__localState.items[0].id)).toBe(1);
    report.checks.push('Edit and confirmed delete flow through local snapshots; Trash/recovery wording matches the local backend and preserves the original fixture item');

    for (const locale of ['en', 'zh']) {
      await page.locator('#settingsToggle').click(); await page.locator(`#uiLanguage button[data-language="${locale}"]`).click(); await page.locator('#settingsPanel').press('Escape');
      await page.locator('.portrait-card[data-id="1"]').click(); await page.locator('#detailCopy').click();
      expect(await page.evaluate(() => window.__localCopy.at(-1))).toBe(await page.evaluate(locale => window.__localState.items[0].prompts[locale], locale));
      expect(await page.evaluate(() => window.__localCalls.filter(call => call.action === 'copyPrompt').at(-1).payload)).toEqual({ id: 1, revision: 1, language: locale });
      expect(await page.evaluate(() => window.__localCalls.filter(call => call.action === 'copyText').length)).toBe(0);
      await page.locator('#closeDialog').click();
    }
    report.checks.push('Desktop full bilingual prompt copying uses fixed id/revision/language copyPrompt and rereads the local fixture backend; copyText is never used and no OS clipboard is touched');
    await page.locator('.portrait-card[data-id="1"]').click();
    const copiedCount = await page.evaluate(() => window.__localCopy.length);
    await page.evaluate(() => { window.__localState.items[0].revision++; window.__localState.items[0].prompts.zh = '后端已更新的提示词'; });
    await page.locator('#detailCopy').click();
    await expect(page.locator('.toast')).toContainText(messages.zh['app.copyFailed']);
    expect(await page.evaluate(() => window.__localCopy.length)).toBe(copiedCount);
    expect(await page.evaluate(() => window.__localCalls.filter(call => call.action === 'copyText').length)).toBe(0);
    await page.locator('#closeDialog').click();
    report.checks.push('A stale desktop item revision makes fixed backend copying fail visibly without falling back to the renderer prompt or copyText');

    await load(); await menu(); await page.locator('#libraryBatch').click();
    await expect(page.locator('#batchTargetRoot')).toHaveText('/isolated-fixture/library');
    await page.locator('#batchChooseDirectory').click(); await page.locator('#batchPreview').click();
    await expect(page.locator('#batchConfirm')).toBeEnabled();
    await page.locator('#batchConfirm').click(); await expect(page.locator('#batchReport')).toBeVisible();
    await page.locator('#batchCancel').click(); await expect(page.locator('.portrait-card')).toHaveCount(2);
    expect(await page.evaluate(() => window.__localState.items.find(item => item.id === 2).prompts)).toEqual({ en: 'Complete batch English prompt', zh: '完整批量中文提示词' });
    report.checks.push('Local automatic source-folder discovery, preview and confirmed batch import use original fixed IPC schema and apply the returned local snapshot');

    await load('zh', '&unconfigured=1'); await menu();
    await expect(page.locator('#libraryStatus')).toHaveText(messages.zh['sidebar.disconnected']);
    await expect(page.locator('#libraryCreate')).toBeDisabled(); await expect(page.locator('#libraryBatch')).toBeDisabled();
    await expect(page.locator('#libraryConfigure')).toHaveText(messages.zh['sidebar.choose']);
    await page.locator('#libraryConfigure').click(); await menu(); await expect(page.locator('#libraryCreate')).toBeEnabled(); await menu();
    report.checks.push('Unconfigured local mode offers the native save-folder entry, then enables management only after a configured writable local snapshot');

    await load('en', '&readonly=1&browser=1'); await menu();
    await expect(page.locator('#libraryStatus')).toHaveText(messages.en['sidebar.readonly']);
    for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) await expect(page.locator(selector)).toBeDisabled();
    await menu(); await page.locator('#settingsToggle').click(); await expect(page.locator('#settingsLibrary')).toBeDisabled();
    await expect(page.locator('#settingsLibraryRoot')).toHaveText('/isolated-fixture/library');
    await page.locator('#settingsPanel').press('Escape');
    await page.locator('.portrait-card[data-id="1"]').click(); await page.locator('#detailCopy').click();
    expect(await page.evaluate(() => window.__localCopy.at(-1))).toBe('Full English local fixture prompt with all details.');
    expect(await page.evaluate(() => window.__localCalls.filter(call => call.action === 'copyText').length)).toBe(1);
    expect(await page.evaluate(() => window.__localCalls.filter(call => call.action === 'copyPrompt').length)).toBe(0);
    report.checks.push('Local browser preview retains read-only controls and local path metadata without exposing server settings');

    await page.locator('#closeDialog').click();
    await page.locator('#beginBatchDelete').click(); await page.locator('#selectVisible').click();
    await page.locator('#batchDeleteSelected').click();
    await expect(page.locator('.delete-description')).toHaveText(messages.en['delete.previewDescription']);
    await expect(page.locator('#deleteConfirm')).toHaveText(messages.en['delete.previewConfirm']);
    await page.locator('#deleteCancel').click(); await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.locator('#batchDeleteSelected').click(); await page.locator('#deleteConfirm').click();
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    expect(await page.evaluate(() => window.__localCalls.filter(call => call.action === 'deletePortrait').at(-1).payload)).toEqual({ id: 1 });
    report.checks.push('Browser batch removal retains the session-only preview route and wording, with cancellation and a fixed id-only request');

    await load('zh', '&readonly=1'); await menu();
    await expect(page.locator('#libraryDeleteBatch')).toBeDisabled(); await menu();
    await expect(page.locator('#beginBatchDelete')).toHaveCount(0); await expect(page.locator('.select-checkbox')).toHaveCount(0);
    report.checks.push('A readonly desktop library exposes no active batch-delete controls');

    await load(); await page.locator('#beginBatchDelete').click(); await page.locator('#selectVisible').click();
    await menu(); await page.locator('#libraryConfigure').click();
    await expect(page.locator('.select-checkbox')).toHaveCount(0);
    await page.locator('#beginBatchDelete').click(); await expect(page.locator('#selectedCount')).toHaveText(messages.zh['gallery.selectedCount'].replace('{count}', '0'));
    report.checks.push('Switching the save folder clears the old selection even when the new library uses the same image ID');

    for (const suffix of ['&legacy=1', '&expired=1']) {
      await load('zh', suffix); await menu(); await expect(page.locator('#libraryCreate')).toBeEnabled(); await expect(page.locator('#libraryBatch')).toBeEnabled(); await menu();
      await page.evaluate(() => { window.__openImageResult = false; });
      await page.locator('.portrait-card[data-id="1"]').click(); await page.locator('#detailOpen').click();
      await expect(page.locator('.portrait-card')).toHaveCount(1); await expect(page.locator('#detailDialog')).toBeVisible();
      expect(await page.evaluate(() => window.__localCalls.filter(call => call.action.startsWith('remote')).length)).toBe(0);
    }
    report.checks.push('Legacy local bridge and irrelevant expired remote metadata never require login; ordinary local open-image failure never probes remote metadata or clears gallery');
    expect(report.errors).toEqual([]); expect(report.previewApiRequests).toEqual([]);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error;
  } finally {
    await browser?.close(); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, previewApiRequests: report.previewApiRequests.length, report: output }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
