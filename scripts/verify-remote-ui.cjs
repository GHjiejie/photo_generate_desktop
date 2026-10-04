const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// This checks React's bridge contract in isolation. The separate native/API
// validation must establish actual network, storage and image behavior.
async function main() {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, chromiumSandbox: true
  });
  const report = { status: 'running', scope: 'Isolated React components with an in-memory remote bridge; no native dialogs, network uploads or server persistence asserted', checks: [], errors: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('portraitStudio.uiLanguage', 'zh');
      window.__calls = [];
      window.portraitStudio = {
        backend: 'remote',
        chooseBatchDirectory: async () => {
          window.__calls.push({ action: 'chooseDirectory' });
          return { ok: true, data: { selectionId: 'directory-1', path: '/isolated/source', imageCount: 1, manifests: [{ candidateId: 'manifest-1', relativePath: 'manifest.json', recordCount: 1 }] } };
        },
        previewBatch: async payload => {
          window.__calls.push({ action: 'preview', payload });
          return { ok: true, data: { previewId: 'preview-1', revision: 4, root: '/private/server/library', total: 1, matched: 1, importable: 1, skipped: 0, conflicts: 0, canImport: true, issues: [], unpaired: [], items: [{ id: 51, label: 'Test image', sourceFileName: '001.png', sourceRelativePath: 'images/001.png', status: 'import', sourceMetadata: { id: 1, prompt: 'Complete original English prompt', prompt_cn: '完整中文提示词' } }] } };
        },
        commitBatch: async payload => {
          window.__calls.push({ action: 'commit', payload });
          return { ok: true, data: { snapshot: { configured: true, writable: true, remote: true, root: '/private/server/library', revision: 5, items: [] }, report: { imported: 1, skipped: 0, conflicts: 0, mapping: [] } } };
        },
        cancelBatch: async payload => { window.__calls.push({ action: 'cancel', payload }); return { ok: true, data: { cancelled: true } }; }
      };
    });
    await page.route('**/src/main.jsx*', route => route.fulfill({ contentType: 'text/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js';
import {I18nProvider, UILanguageControl} from '/src/i18n.jsx';
import LibraryMenu from '/src/components/LibraryMenu.jsx';
import BatchImportDialog from '/src/components/BatchImportDialog.jsx';
import '/styles.css';
const testRoot = ReactDOMClient.createRoot(document.getElementById('root'));
let state = {desktop:true,connected:true,editable:true,pending:false,batchOpen:false,library:{configured:true,writable:true,remote:true,connected:true,root:'/private/server/library',revision:4,items:[]}};
const action = value => () => window.__calls.push({action:value});
window.__setScene = values => {state={...state,...values,library:{...state.library,...values.library}};render();};
window.__setLanguage = locale => document.querySelector('#uiTestLanguage button[data-language="'+locale+'"]').click();
function render() {
  testRoot.render(React.createElement(I18nProvider,null,React.createElement(React.Fragment,null,
    React.createElement(UILanguageControl,{id:'uiTestLanguage'}),
    React.createElement('div',{style:{position:'relative',margin:'32px',width:'280px'}},React.createElement(LibraryMenu,{...state,onConfigure:action('connect'),onRefresh:action('refresh'),onCreate:action('create'),onBatch:()=>window.__setScene({batchOpen:true})})),
    React.createElement(BatchImportDialog,{open:state.batchOpen,root:state.library.root,allowed:state.editable,onClose:()=>window.__setScene({batchOpen:false}),onImported:action('imported')})
  )));
}
render();
` }));
    await page.goto('http://127.0.0.1:5173/');
    await expect(page.locator('#uiTestLanguage')).toBeVisible();
    const messages = require('../src/ui-messages.json');
    async function openMenu() {
      if (!await page.locator('#libraryMenuPanel').isVisible()) await page.locator('#libraryMenuToggle').click();
    }
    async function scene(values) {
      await page.evaluate(values => window.__setScene(values), values);
    }
    for (const locale of ['zh', 'en']) {
      await page.evaluate(locale => window.__setLanguage(locale), locale);
      await openMenu();
      await expect(page.locator('#libraryStatus')).toHaveText(messages[locale]['sidebar.editable']);
      await expect(page.locator('#libraryRoot')).toHaveText(messages[locale]['sidebar.serverLocation']);
      await expect(page.locator('#libraryConfigure')).toHaveText(messages[locale]['sidebar.switch']);
      await expect(page.locator('.library-menu-actions > button')).toHaveCount(4);
      await expect(page.locator('#libraryMenuPanel')).not.toContainText('/private/server/library');
      await page.locator('#libraryConfigure').click();
      await expect(page.locator('#libraryMenuPanel')).toHaveCount(0);
    }
    expect(await page.evaluate(() => window.__calls.filter(call => call.action === 'connect').length)).toBe(2);
    report.checks.push('Both languages show server connection and localized destination; existing four-action menu retained and connect action closes menu');

    await scene({ editable: false, library: { writable: false } });
    await openMenu();
    await expect(page.locator('#libraryStatus')).toHaveText(messages.en['sidebar.readonly']);
    await expect(page.locator('#libraryCreate')).toBeDisabled();
    await expect(page.locator('#libraryBatch')).toBeDisabled();
    await expect(page.locator('#libraryConfigure')).toBeEnabled();
    await expect(page.locator('#libraryRefresh')).toBeEnabled();
    report.checks.push('Read-only server snapshot disables imports while retaining connection and refresh');

    await scene({ desktop: false, editable: true, library: { writable: true } });
    for (const id of ['libraryCreate', 'libraryConfigure', 'libraryBatch']) await expect(page.locator(`#${id}`)).toBeDisabled();
    await expect(page.locator('#libraryRefresh')).toBeEnabled();
    report.checks.push('Browser preview disables all three desktop write/configuration actions');

    await scene({ desktop: true, library: { configured: false, connected: false } });
    await expect(page.locator('#libraryStatus')).toHaveText(messages.en['sidebar.disconnected']);
    await expect(page.locator('#libraryRoot')).toHaveCount(0);
    await expect(page.locator('#libraryConfigure')).toHaveText(messages.en['sidebar.choose']);
    report.checks.push('Disconnected server state offers connection without a local storage-folder prompt');

    await scene({ editable: true, library: { configured: true, connected: true } });
    await page.locator('#libraryBatch').click();
    await expect(page.locator('#batchTargetRoot')).toHaveText(messages.en['sidebar.serverLocation']);
    await page.locator('#batchChooseDirectory').click();
    await expect(page.locator('#batchManifestPath')).toHaveText('manifest.json');
    await expect(page.locator('#batchManifestCandidate')).toHaveCount(0);
    await page.locator('#batchPreview').click();
    await expect(page.locator('#batchItems')).toContainText('images/001.png');
    await expect(page.locator('#batchTargetRoot')).toHaveText(messages.en['sidebar.serverLocation']);
    expect(await page.evaluate(() => window.__calls.filter(call => call.action === 'commit').length)).toBe(0);
    await page.locator('#batchItems details summary').click();
    await expect(page.locator('#batchItems details pre')).toContainText('"id": 1');
    await page.locator('#batchConfirm').click();
    await expect(page.locator('#batchReport')).toContainText('Imported 1');
    const commits = await page.evaluate(() => window.__calls.filter(call => call.action === 'commit'));
    expect(commits).toEqual([{ action: 'commit', payload: { previewId: 'preview-1', confirmed: true, expectedVersion: 4 } }]);
    await page.locator('#batchCancel').click();
    report.checks.push('Single source-folder discovery, server destination, preserved source ID, preview before explicit confirmed commit and CAS version remain wired');
    expect(report.errors).toEqual([]);
    report.status = 'passed';
    report.calls = await page.evaluate(() => window.__calls);
  } finally {
    await browser.close();
    const reportPath = path.join(__dirname, '../.verification/remote-client-ui.json');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportPath, errors: report.errors }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
