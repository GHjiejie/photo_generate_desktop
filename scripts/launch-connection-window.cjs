'use strict';

// This launches the actual project main, without a bootstrap or HTTP substitute.
// Keep the resulting source window alive for the user's secure sign-in action.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { RECOMMENDED_ENDPOINT, writeRemoteConfiguration } = require('../remote-config.cjs');
const project = path.resolve(__dirname, '..');
const output = path.join(project, '.verification');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-user-source-')));
const profile = path.join(temporary, 'user-source-profile');
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[^0-9TZ]/g, '');
const reportPath = path.join(output, `live-source-connection-${stamp}.json`);
const screenshotPath = path.join(output, `live-source-connection-${stamp}-1440x920.png`);
const indexPath = path.join(project, 'photo_repo/.portrait-studio/library.json');
const indexBefore = fs.readFileSync(indexPath);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { purpose: 'Live production source Electron window retained for the user; not a verification fixture instance.', startedAt, project, profile, temporary, reportPath, screenshotPath,
  endpoint: RECOMMENDED_ENDPOINT, bootstrapUsed: false, fetchMockUsed: false, credentialsProvided: false, signInClicked: false,
  remoteMutationRequested: false, originalApplicationsTouched: false, live: false, stage: 'prepared', errors: [] };
let app, keepAlive;
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(profile, { mode: 0o700 });
function save() { fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
async function main() {
  try {
    await writeRemoteConfiguration(profile, RECOMMENDED_ENDPOINT);
    const configPath = path.join(profile, 'remote-connection.json');
    report.configuration = { path: configPath, mode: (fs.statSync(configPath).mode & 0o777).toString(8), value: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    expect(report.configuration.mode).toBe('600'); expect(report.configuration.value).toEqual({ version: 1, endpoint: RECOMMENDED_ENDPOINT });
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PORTRAIT_STUDIO_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
    env.PORTRAIT_STUDIO_USER_DATA_DIR = profile;
    report.environment = { profileOverrideOnly: true, remoteBaseURLPresent: false, authorizationPresent: false, electronRunAsNodePresent: false };
    report.stage = 'launching-production-source'; save();
    app = await electron.launch({ executablePath: require('electron'), args: [project], env });
    report.pid = app.process().pid; report.launcherPid = process.pid; report.live = true;
    const page = await app.firstWindow();
    page.on('pageerror', error => { report.errors.push(error.message); save(); });
    page.on('close', () => { report.windowVisible = false; report.windowClosedAt = new Date().toISOString(); save(); });
    app.process().on('exit', () => { report.live = false; report.processExitedAt = new Date().toISOString(); save(); clearInterval(keepAlive); });
    await expect(page.locator('#settingsToggle')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.locator('#settingsToggle').click();
    await expect(page.locator('#settingsConnection')).toBeEnabled({ timeout: 20000 });
    await page.locator('#settingsConnection').click();
    await expect(page.locator('#remoteConnectionDialog')).toBeVisible();
    await expect(page.locator('#remoteEndpoint')).toHaveValue(RECOMMENDED_ENDPOINT);
    await expect(page.locator('#remoteSignIn')).toBeEnabled();
    report.bridge = await page.evaluate(() => ({ backend: window.portraitStudio.backend, rendererRequire: typeof window.require, passwordInputsInReact: document.querySelectorAll('input[type="password"]').length }));
    expect(report.bridge).toEqual({ backend: 'remote', rendererRequire: 'undefined', passwordInputsInReact: 0 });
    report.connectionSettings = await page.evaluate(() => window.portraitStudio.connectionSettings());
    expect(report.connectionSettings.ok).toBe(true);
    expect(report.connectionSettings.data.source).toBe('saved'); expect(report.connectionSettings.data.environmentOverride).toBe(false); expect(report.connectionSettings.data.authorizationProvided).toBe(false);
    report.ui = { statusClass: await page.locator('#remoteConnectionStatus').getAttribute('class'), text: await page.locator('#remoteConnectionStatus').innerText(), signInEnabled: await page.locator('#remoteSignIn').isEnabled(), viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) };
    report.window = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0], prefs = window.webContents.getLastWebPreferences();
      return { id: window.id, visible: window.isVisible(), url: window.webContents.getURL(), profile: app.getPath('userData'), contentSize: window.getContentSize(), sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, webSecurity: prefs.webSecurity };
    });
    expect(report.window.profile).toBe(profile); report.windowVisible = report.window.visible;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: screenshotPath, scale: 'css', animations: 'disabled' });
    const png = PNG.sync.read(fs.readFileSync(screenshotPath)); report.screenshotPixels = { width: png.width, height: png.height };
    expect(report.screenshotPixels).toEqual({ width: 1440, height: 920 });
    report.realLibraryIndex = { sha256Before: sha(indexBefore), sha256After: sha(fs.readFileSync(indexPath)), unchanged: indexBefore.equals(fs.readFileSync(indexPath)) };
    expect(report.realLibraryIndex.unchanged).toBe(true);
    report.stage = 'live-user-window-ready'; report.readyAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: 'live-user-window-ready', pid: report.pid, launcherPid: report.launcherPid, profile, report: reportPath, screenshot: screenshotPath, connectionStatus: report.connectionSettings.data.status, errorCode: report.connectionSettings.data.lastErrorCode, uiStatus: report.ui.statusClass, secureSignInEnabled: true }));
    // The exec session owns this launcher and the real Electron child. The user
    // can now operate the visible window; successful delivery never closes it.
    keepAlive = setInterval(() => {}, 60000);
  } catch (error) {
    report.stage = 'failed'; report.error = error.stack; save(); console.error(error);
    if (app) { await app.close(); report.live = false; save(); }
    process.exitCode = 1;
  }
}
main();
