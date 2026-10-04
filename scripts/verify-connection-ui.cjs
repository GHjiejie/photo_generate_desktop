'use strict';
const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const uiMessages = require('../src/ui-messages.json');
const messages = Object.fromEntries(Object.entries(uiMessages).map(([language, catalog]) => [language, {
  ...catalog, ...Object.fromEntries(Object.entries(catalog).filter(([key]) => key.startsWith('remote.')).map(([key, value]) => [key.slice(7), value]))
}]));
const target = 'https://dashboard-18-180-65-241.sslip.io/portrait-studio/';
const output = path.resolve(__dirname, '../.verification/connection-ui.json');
const report = { status: 'running', scope: 'Production React App with an isolated in-memory fixed bridge for connection-state UI checks; no actual API reachability, authentication or persistence asserted.', checks: [], errors: [] };
let browser;
(async () => {
  try {
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.addInitScript(({ target }) => {
      if (location.origin !== 'http://127.0.0.1:5173') return;
      const params = new URL(location.href).searchParams;
      const code = params.get('state') || 'REMOTE_NOT_CONFIGURED';
      localStorage.setItem('portraitStudio.uiLanguage', params.get('lang') || 'zh');
      localStorage.setItem('portraitStudio.theme', 'dark');
      localStorage.setItem('portraitStudio.sidebarCollapsed', 'false');
      window.__connectionCalls = [];
      window.__operationCodes = {};
      window.__connectionCode = code;
      window.__signInResult = { ok: true, data: { cancelled: true } };
      window.__platformAuthentication = { kind: 'platform', username: 'admin', expiresAt: new Date(Date.now() + 3600000).toISOString() };
      if (params.get('platform') === 'none') window.__platformAuthentication = null;
      window.__settings = { endpoint: code === 'REMOTE_NOT_CONFIGURED' ? '' : target, recommendedEndpoint: target, configured: code !== 'REMOTE_NOT_CONFIGURED', source: 'saved', environmentOverride: false, authorizationProvided: true, authentication: code === 'CONNECTED' ? window.__platformAuthentication : null };
      if (params.has('development')) window.__settings = { ...window.__settings, endpoint: 'http://127.0.0.1:44138/', configured: true, environmentOverride: true, developmentLoginAllowed: params.get('development') === 'attested' };
      const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3l8AAAAASUVORK5CYII=';
      const item = { id: 1, revision: 1, label: 'Isolated fixture', type: 'photo', image: 'fixture.png', image_url: image, prompts: { en: 'Complete English fixture prompt', zh: '完整中文测试提示词' } };
      const snapshot = () => ({ configured: true, remote: true, writable: true, root: 'Server library', revision: 1, authentication: window.__platformAuthentication, items: params.has('one') ? [item] : [] });
      const response = () => window.__connectionCode === 'CONNECTED' ? { ok: true, data: snapshot() } : { ok: false, error: { code: window.__connectionCode } };
      function operation(action, data, payload) {
        window.__connectionCalls.push({ action, payload });
        const failure = window.__operationCodes[action];
        if (!failure) return { ok: true, data };
        if (['AUTH_REQUIRED', 'REMOTE_AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(failure)) window.__settings = { ...window.__settings, authentication: null, lastErrorCode: failure, status: 'error' };
        return { ok: false, error: { code: failure } };
      }
      window.portraitStudio = {
        backend: 'remote', ...(params.get('browser') ? { mode: 'browser-preview' } : {}),
        setUILanguage: async locale => ({ ok: true, data: { locale } }),
        connectionSettings: async () => { window.__connectionCalls.push({ action: 'settings' }); return code === 'INVALID_REMOTE_CONFIG' ? { ok: false, error: { code } } : { ok: true, data: { ...window.__settings } }; },
        libraryList: async () => { window.__connectionCalls.push({ action: 'list' }); return response(); },
        libraryGet: async id => { window.__connectionCalls.push({ action: 'get', id }); return window.__holdDetail ? new Promise(resolve => window.__resolveDetail = resolve) : { ok: true, data: { item } }; },
        chooseImage: async () => operation('chooseImage', { token: 'isolated-image-selection', name: 'fixture.png', previewURL: image }),
        releaseImage: async token => operation('releaseImage', { released: true }, token),
        createPortrait: async payload => operation('createPortrait', snapshot(), payload),
        updatePortrait: async payload => operation('updatePortrait', snapshot(), payload),
        deletePortrait: async payload => operation('deletePortrait', snapshot(), payload),
        chooseBatchDirectory: async () => operation('chooseBatchDirectory', { selectionId: 'isolated-directory-selection', path: 'Isolated source folder', imageCount: 1, manifests: [{ candidateId: 'isolated-manifest', relativePath: 'manifest.json', recordCount: 1 }] }),
        previewBatch: async payload => operation('previewBatch', { previewId: 'isolated-preview', revision: 1, canImport: true, total: 1, matched: 1, importable: 1, skipped: 0, conflicts: 0, items: [{ id: 2, label: 'Isolated batch record', sourceFileName: 'fixture.png', status: 'importable' }], issues: [], unpaired: [] }, payload),
        commitBatch: async payload => operation('commitBatch', { snapshot: snapshot(), report: { imported: 1, skipped: 0, conflicts: 0 } }, payload),
        cancelBatch: async payload => operation('cancelBatch', { released: true }, payload),
        copyPrompt: async payload => operation('copyPrompt', true, payload).ok,
        openImage: async payload => operation('openImage', true, payload).ok,
        chooseLibrary: async () => { window.__connectionCalls.push({ action: 'connect' }); return window.__holdConnect ? new Promise(resolve => window.__resolveConnect = resolve) : window.__connectResult || response(); },
        saveConnection: async payload => { window.__connectionCalls.push({ action: 'save', payload }); window.__settings = { ...window.__settings, endpoint: payload.endpoint, configured: true, status: 'configured' }; return { ok: true, data: { ...window.__settings } }; },
        signIn: async () => { window.__connectionCalls.push({ action: 'signIn' }); return window.__signInResult; },
        logout: async () => { window.__connectionCalls.push({ action: 'logout' }); window.__settings.authentication = null; return { ok: true, data: { ...window.__settings, serverLoggedOut: window.__logoutConfirmed !== false, logoutErrorCode: window.__logoutConfirmed === false ? 'REMOTE_UNAVAILABLE' : null } }; }
      };
    }, { target });
    async function load(code, locale = 'zh', browserPreview = false, development) {
      await page.goto(`http://127.0.0.1:5173/?state=${code}&lang=${locale}${browserPreview ? '&browser=1' : ''}${development ? `&development=${development}` : ''}`);
      await expect(page.locator('#libraryMenuToggle')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.__connectionCalls?.filter(call => call.action === 'list').length)).toBe(1);
      await page.locator('#libraryMenuToggle').click();
      await expect(page.locator('#libraryConfigure')).toBeEnabled();
    }
    const states = { REMOTE_NOT_CONFIGURED: 'unconfigured', REMOTE_AUTH_REQUIRED: 'auth-required', REMOTE_FORBIDDEN: 'forbidden',
      REMOTE_ROUTE_MISSING: 'route-missing', REMOTE_SERVICE_UNAVAILABLE: 'service-unavailable', REMOTE_TIMEOUT: 'timeout',
      REMOTE_UNAVAILABLE: 'unreachable', REMOTE_INVALID_RESPONSE: 'invalid-response', INVALID_REMOTE_CONFIG: 'invalid-config',
      AUTH_REQUIRED: 'auth-required', SESSION_EXPIRED: 'session-expired', AUTH_NOT_INITIALIZED: 'not-initialized',
      INVALID_CREDENTIALS: 'invalid-credentials', AUTH_RATE_LIMITED: 'login-rate-limited',
      REMOTE_GATEWAY_AUTH_REQUIRED: 'gateway-auth-required', PLATFORM_AUTH_UNAVAILABLE: 'platform-unavailable' };
    for (const locale of ['zh', 'en']) for (const [code, status] of Object.entries(states)) {
      await load(code, locale);
      await expect(page.locator('#libraryStatus')).toHaveText(messages[locale][`connection.status.${status}`]);
      await expect(page.locator('#libraryCreate')).toBeDisabled(); await expect(page.locator('#libraryBatch')).toBeDisabled();
      await page.locator('#libraryConfigure').click();
      await expect(page.locator('#remoteConnectionDialog')).toBeVisible();
      await expect(page.locator('#remoteConnectionStatus')).toContainText(messages[locale][`connection.status.${status}`]);
      await expect(page.locator('#remoteEndpoint')).toHaveValue(target);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      await expect(page.locator('#remotePlatformAccount')).toContainText('admin');
      await expect(page.locator('#remoteSessionStatus')).toContainText(messages[locale][code === 'SESSION_EXPIRED' ? 'connection.session.expired' : 'connection.session.signedOut']);
      await expect(page.locator('.portrait-card')).toHaveCount(0);
      if (code === 'INVALID_REMOTE_CONFIG') {
        await expect(page.locator('#remoteEndpoint')).toBeDisabled();
        await expect(page.locator('#remoteSaveConnect')).toBeDisabled();
        await expect(page.locator('#remoteSignIn')).toBeDisabled();
      }
      if (['AUTH_NOT_INITIALIZED', 'REMOTE_GATEWAY_AUTH_REQUIRED', 'PLATFORM_AUTH_UNAVAILABLE'].includes(code)) await expect(page.locator('#remoteSignIn')).toBeDisabled();
      await expect(page.locator('#remoteSignOut')).toHaveCount(0);
      report.checks.push({ locale, code, visibleStatus: status, noFakeLibrary: true });
    }

    await load('REMOTE_NOT_CONFIGURED');
    await page.locator('#libraryConfigure').click();
    await page.locator('#remoteEndpoint').fill('http://insecure.example/portrait-studio/');
    await page.locator('#remoteSaveConnect').click();
    await expect(page.locator('#remoteConnectionValidation')).toHaveText(messages.zh['connection.invalidAddress']);
    expect(await page.evaluate(() => window.__connectionCalls.filter(call => ['save', 'connect'].includes(call.action)).length)).toBe(0);
    report.checks.push('An invalid non-HTTPS address is rejected before configuration or connection IPC');

    await page.locator('#remoteEndpoint').fill(target);
    await page.evaluate(() => { window.__holdConnect = true; });
    await page.locator('#remoteSaveConnect').click();
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.connecting']);
    await expect(page.locator('#remoteSaveConnect')).toBeDisabled();
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    expect(await page.evaluate(() => window.__connectionCalls.filter(call => call.action === 'save'))).toEqual([{ action: 'save', payload: { endpoint: target } }]);
    await page.evaluate(() => window.__resolveConnect({ ok: false, error: { code: 'REMOTE_AUTH_REQUIRED' } }));
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.auth-required']);
    await expect(page.locator('#remoteSignIn')).toBeEnabled();
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    report.checks.push('Saved address metadata remains disconnected until an actual query result; 401 after save enables secure sign-in and shows no fake cards');

    await page.evaluate(() => { window.__holdConnect = false; window.__connectResult = { ok: true, data: { cancelled: true } }; });
    await page.locator('#remoteSaveConnect').click();
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.auth-required']);
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    report.checks.push('A cancelled legacy connection result cannot create a library snapshot or a connected success state');

    await page.locator('#remoteSignIn').click();
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.auth-required']);
    await page.evaluate(() => { window.__signInResult = { ok: true, data: { configured: true, remote: true, writable: true, root: 'Server library', revision: 1, authentication: window.__platformAuthentication, items: [] } }; });
    await page.locator('#remoteSignIn').click();
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.connected']);
    await page.locator('#remoteConnectionClose').click();
    await expect(page.locator('#emptyState')).toContainText(messages.zh['gallery.emptyTitle']);
    await page.locator('#libraryMenuToggle').click();
    await expect(page.locator('#libraryCreate')).toBeEnabled();
    await expect(page.locator('#libraryStatus')).toHaveText(messages.zh['sidebar.editable']);
    report.checks.push('Cancelled secure sign-in retains the failed state; only a returned verified snapshot creates connected state, and a valid empty library is distinct from missing service');

    await page.locator('#libraryConfigure').click();
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.active']);
    const expiresAt = await page.evaluate(() => window.__platformAuthentication.expiresAt);
    await expect(page.locator('#remoteSessionExpires time')).toHaveAttribute('datetime', expiresAt);
    await expect(page.locator('#remoteSignOut')).toBeEnabled();
    report.checks.push('Verified platform metadata displays fixed admin, signed-in session and the exact RFC3339 expiration');
    await page.evaluate(() => { window.__logoutConfirmed = false; });
    await page.locator('#remoteSignOut').click();
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.auth-required']);
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.signedOut']);
    await expect(page.locator('#remoteLogoutStatus')).toHaveText(messages.zh['connection.signedOutUnconfirmed']);
    await expect(page.locator('#remoteSignOut')).toHaveCount(0);
    await expect(page.locator('#remoteSessionExpires')).toHaveCount(0);
    await page.locator('#remoteConnectionClose').click();
    await page.locator('#libraryMenuToggle').click();
    await expect(page.locator('#libraryCreate')).toBeDisabled(); await expect(page.locator('#libraryBatch')).toBeDisabled();
    await expect(page.locator('.portrait-card')).toHaveCount(0);
    report.checks.push('Logout metadata clears the local session, expiry display and write permission without applying it as a snapshot or claiming unconfirmed server revocation');

    await load('AUTH_REQUIRED');
    await page.locator('#libraryConfigure').click();
    await page.evaluate(() => { window.__platformAuthentication.expiresAt = new Date(Date.now() + 1800).toISOString(); window.__signInResult = { ok: true, data: { configured: true, remote: true, writable: true, root: 'Server library', revision: 1, authentication: window.__platformAuthentication, items: [] } }; });
    await page.locator('#remoteSignIn').click();
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.active']);
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.session-expired'], { timeout: 5000 });
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.expired']);
    expect(await page.evaluate(() => window.__connectionCalls.filter(call => call.action === 'signIn').length)).toBe(1);
    report.checks.push('Expiration of a known session clears local access and requests manual sign-in without opening another login window');

    for (const development of ['unattested', 'attested']) {
      await load('AUTH_REQUIRED', 'zh', false, development);
      await page.locator('#libraryConfigure').click();
      await expect(page.locator('#remoteEndpoint')).toHaveAttribute('readonly', '');
      if (development === 'attested') await expect(page.locator('#remoteSignIn')).toBeEnabled();
      else await expect(page.locator('#remoteSignIn')).toBeDisabled();
    }
    report.checks.push('HTTP development login is enabled only by explicit main-projected developmentLoginAllowed:true; URL text alone grants no permission and GUI configuration remains readonly');

    await page.goto('http://127.0.0.1:5173/?state=CONNECTED&lang=zh&platform=none');
    await page.locator('#libraryMenuToggle').click();
    await expect(page.locator('#libraryStatus')).toHaveText(messages.zh['sidebar.readonly']);
    await expect(page.locator('#libraryCreate')).toBeDisabled(); await expect(page.locator('#libraryBatch')).toBeDisabled();
    await page.locator('#libraryConfigure').click();
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.signedOut']);
    report.checks.push('A valid query or old gateway authorization flag cannot grant platform session or editable library status');

    async function loadManagedFixture() {
      await page.goto('http://127.0.0.1:5173/?state=CONNECTED&lang=zh&one=1');
      await expect(page.locator('.portrait-card[data-id="1"]')).toBeVisible();
      await page.locator('#libraryMenuToggle').click();
      await expect(page.locator('#libraryCreate')).toBeEnabled();
    }
    async function expectInvalidated(code, status) {
      await expect(page.locator('#libraryNotice')).toContainText(messages.zh[`connection.status.${status}`]);
      await expect(page.locator('.portrait-card')).toHaveCount(0);
      for (const selector of ['#portraitEditor', '#deleteConfirmDialog', '#batchImportDialog', '#detailDialog']) await expect(page.locator(selector)).toBeHidden();
      await page.locator('#libraryMenuToggle').click();
      await expect(page.locator('#libraryCreate')).toBeDisabled();
      await expect(page.locator('#libraryBatch')).toBeDisabled();
      await page.locator('#libraryConfigure').click();
      await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh[`connection.status.${status}`]);
      await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh[code === 'SESSION_EXPIRED' ? 'connection.session.expired' : 'connection.session.signedOut']);
      await expect(page.locator('#remoteSignOut')).toHaveCount(0);
      expect(await page.evaluate(() => window.__connectionCalls.filter(call => call.action === 'signIn').length)).toBe(0);
    }

    await loadManagedFixture();
    await page.locator('#libraryCreate').click();
    await page.evaluate(() => { window.__operationCodes.chooseImage = 'AUTH_REQUIRED'; });
    await page.locator('#portraitChooseImage').click();
    await expectInvalidated('AUTH_REQUIRED', 'auth-required');
    report.checks.push('Image selection authentication failure clears the verified gallery, editor and management permission without auto sign-in');

    await loadManagedFixture();
    await page.locator('#libraryCreate').click();
    await page.locator('#portraitChooseImage').click();
    await page.locator('#portraitLabel').fill('Preserved fixture draft');
    await page.locator('#portraitPromptEn').fill('Preserved complete English draft');
    await page.locator('#portraitPromptZh').fill('保留完整中文草稿');
    await page.evaluate(() => { window.__operationCodes.createPortrait = 'INVALID_INPUT'; });
    await page.locator('#portraitSave').click();
    await expect(page.locator('#portraitFormError')).toBeVisible();
    await expect(page.locator('#portraitEditor')).toBeVisible();
    await expect(page.locator('#portraitLabel')).toHaveValue('Preserved fixture draft');
    await expect(page.locator('#portraitPromptEn')).toHaveValue('Preserved complete English draft');
    await expect(page.locator('#portraitPromptZh')).toHaveValue('保留完整中文草稿');
    await expect(page.locator('.portrait-card')).toHaveCount(1);
    await page.evaluate(() => { window.__operationCodes.createPortrait = 'SESSION_EXPIRED'; });
    await page.locator('#portraitSave').click();
    await expectInvalidated('SESSION_EXPIRED', 'session-expired');
    report.checks.push('Ordinary create validation failure preserves both full prompt drafts; a subsequent expired-session save closes the editor and invalidates access');

    await loadManagedFixture();
    await page.locator('#libraryMenuToggle').click();
    await page.locator('.portrait-card[data-id="1"]').click();
    await page.locator('#detailDelete').click();
    await page.evaluate(() => { window.__operationCodes.deletePortrait = 'AUTH_REQUIRED'; });
    await page.locator('#deleteConfirm').click();
    await expectInvalidated('AUTH_REQUIRED', 'auth-required');
    report.checks.push('Confirmed delete authentication failure clears both detail and confirmation windows and disables writes');

    for (const stage of ['previewBatch', 'commitBatch']) {
      await loadManagedFixture();
      await page.locator('#libraryBatch').click();
      await page.locator('#batchChooseDirectory').click();
      await expect(page.locator('#batchPreview')).toBeEnabled();
      await page.evaluate(stage => { window.__operationCodes[stage] = stage === 'previewBatch' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED'; }, stage);
      await page.locator('#batchPreview').click();
      if (stage === 'commitBatch') {
        await expect(page.locator('#batchConfirm')).toBeEnabled();
        await page.locator('#batchConfirm').click();
      }
      await expectInvalidated(stage === 'previewBatch' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED', stage === 'previewBatch' ? 'auth-required' : 'session-expired');
      const recorded = await page.evaluate(() => window.__connectionCalls);
      expect(recorded.some(call => call.action === stage)).toBe(true);
      if (stage === 'previewBatch') expect(recorded.some(call => call.action === 'commitBatch')).toBe(false);
      report.checks.push(`${stage} authentication failure propagates from BatchImportDialog to clear global session and management state`);
    }

    for (const action of ['copyPrompt', 'openImage']) {
      await loadManagedFixture();
      await page.locator('#libraryMenuToggle').click();
      await page.locator('.portrait-card[data-id="1"]').click();
      const before = await page.evaluate(() => window.__connectionCalls.filter(call => call.action === 'settings').length);
      await page.evaluate(action => { window.__operationCodes[action] = 'SESSION_EXPIRED'; }, action);
      await page.locator(action === 'copyPrompt' ? '#detailCopy' : '#detailOpen').click();
      await expectInvalidated('SESSION_EXPIRED', 'session-expired');
      expect(await page.evaluate(() => window.__connectionCalls.filter(call => call.action === 'settings').length)).toBe(before + 1);
      report.checks.push(`${action} false result consults readonly main metadata and invalidates an expired session without changing the boolean bridge contract`);
    }

    await loadManagedFixture();
    await page.locator('#libraryMenuToggle').click();
    await page.evaluate(() => { window.__holdDetail = true; });
    await page.locator('.portrait-card[data-id="1"]').click();
    await expect.poll(() => page.evaluate(() => typeof window.__resolveDetail)).toBe('function');
    await page.locator('#libraryMenuToggle').click();
    await page.locator('#libraryConfigure').click();
    await page.evaluate(() => { window.__signInResult = { ok: true, data: { configured: true, remote: true, writable: true, root: 'Server library', revision: 2, authentication: window.__platformAuthentication, items: [{ id: 2, revision: 1, label: 'New verified session item', type: 'photo', image: 'fixture.png', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+y3l8AAAAASUVORK5CYII=', prompts: { en: 'New full prompt', zh: '新的完整提示词' } }] } }; });
    await page.locator('#remoteSignIn').click();
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.active']);
    await page.evaluate(() => window.__resolveDetail({ ok: false, error: { code: 'SESSION_EXPIRED' } }));
    await expect(page.locator('#remoteSessionStatus')).toContainText(messages.zh['connection.session.active']);
    await expect(page.locator('#remoteConnectionStatus')).toContainText(messages.zh['connection.status.connected']);
    await expect(page.locator('.portrait-card[data-id="2"]')).toHaveCount(1);
    await expect(page.locator('#libraryNotice')).toHaveCount(0);
    report.checks.push('A stale previous-session detail failure cannot invalidate a newly verified sign-in or replace its gallery');

    await page.goto('http://127.0.0.1:5173/?state=CONNECTED&lang=zh&browser=1');
    await page.locator('#settingsToggle').click();
    await expect(page.locator('#settingsConnection')).toBeDisabled();
    await page.locator('#settingsPanel').press('Escape');
    await page.locator('#libraryMenuToggle').click();
    for (const selector of ['#libraryCreate', '#libraryConfigure', '#libraryBatch']) await expect(page.locator(selector)).toBeDisabled();
    report.checks.push('Browser preview disables server configuration, secure sign-in entry and all import actions even if the bridge exposes those methods');
    expect(report.errors).toEqual([]);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.message; throw error;
  } finally {
    await browser?.close(); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors, report: output }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
