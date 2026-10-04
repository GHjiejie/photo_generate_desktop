'use strict';

// Narrow continuation only: do not reopen the real library/source after their
// preservation boundary was released for the parent's authorized import.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const local = require('./import-local-portraits.cjs');
const { project, ordinaryFile, fingerprint, sha, indexRelative } = local;
const output = path.join(project, '.verification');
const primaryPath = path.join(output, 'local-native-1.6.0-20261004T130606897Z-verification.json');
const directoryPath = path.join(output, 'local-native-1.6.0-20261004T131724564Z-verification.json');
const releasePath = path.join(output, 'local-native-preservation-release.json');
const read = file => JSON.parse(ordinaryFile(file));
const primary = read(primaryPath), directory = read(directoryPath), release = read(releasePath);
expect(primary.status).toBe('failed'); expect(primary.stage).toBe('native-crud');
expect(primary.commitSucceeded).toBe(true); expect(primary.checks).toHaveLength(3);
expect(primary.copies).toHaveLength(16); expect(primary.screenshots).toHaveLength(4);
expect(directory.status).toBe('failed'); expect(directory.stage).toBe('persisted-root-restart');
expect(directory.checks).toHaveLength(2); expect(directory.error.message).toContain('ENOENT');
expect(directory.error.actualBatchIPC).toEqual([
  { channel: 'library-batch-directory-choose', ok: true },
  { channel: 'library-batch-preview', ok: true, total: 2, matched: 2, importable: 2 },
  { channel: 'library-batch-cancel', ok: true }
]);
expect(release.status).toBe('unchanged-released-for-root-authorized-import');
expect(release.original55FilesUnchanged).toBe(true); expect(release.source52FilesUnchanged).toBe(true);
expect(primary.applications.concat(directory.applications).every(item => item.closed && item.processGone)).toBe(true);
const { temporary, library, profile } = directory;
expect(primary.temporary).toBe(temporary); expect(primary.library).toBe(library); expect(primary.profile).toBe(profile);
expect(fs.realpathSync(temporary)).toBe(temporary);
expect(path.dirname(temporary)).toBe(fs.realpathSync(os.tmpdir()));
expect(path.basename(temporary)).toMatch(/^portrait-local-native-[A-Za-z0-9]+$/);
expect(library).toBe(path.join(temporary, 'isolated-repository'));
expect(profile).toBe(path.join(temporary, 'isolated-profile'));
const configPath = path.join(profile, 'library-config.json');
const configBefore = ordinaryFile(configPath), configInfo = fs.lstatSync(configPath);
expect(JSON.parse(configBefore)).toEqual({ version: 1, root: library });
expect(configInfo.mode & 0o777).toBe(0o600); expect(configInfo.uid).toBe(process.getuid());
const privateIndex = read(path.join(library, indexRelative));
expect(privateIndex.schemaVersion).toBe(1); expect(privateIndex.items).toHaveLength(100); expect(privateIndex.revision).toBe(6);
const before = fingerprint(library);
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const prefix = `local-native-completion-${stamp}`;
const reportPath = path.join(output, `${prefix}.json`);
const screenshotPath = path.join(output, `${prefix}-restart-gallery-1440x920.png`);
const checks = [], errors = [];
let app, page, processInfo, status = 'in-progress', stage = 'profile-verified', failure;
function save() {
  fs.writeFileSync(reportPath, `${JSON.stringify({ status, stage, project, temporary, library, profile,
    scope: 'Only the previously owned temporary100/revision6 library and profile; no reads/writes of real photo_repo or Downloads after releasedAt.',
    realPreservationBoundary: { reportPath: releasePath, releasedAt: release.releasedAt,
      original55FilesUnchanged: release.original55FilesUnchanged, source52FilesUnchanged: release.source52FilesUnchanged },
    multiAttempt: true, coreRepeated: false, batchRepeated: false,
    primaryCore: { reportPath: primaryPath, sha256: sha(ordinaryFile(primaryPath)),
      checks: primary.checks, imported: primary.imported, copies: primary.copies, screenshots: primary.screenshots,
      originalFailurePreserved: true, failureCause: 'Harness compared recovery SHA to public item.sha256, which is deliberately absent; actual raw recovery/item/image SHA was subsequently verified.' },
    directoryContinuation: { reportPath: directoryPath, sha256: sha(ordinaryFile(directoryPath)),
      checks: directory.checks, actualIPC: directory.error.actualBatchIPC, batchPreviews: directory.batchPreviews,
      screenshots: directory.screenshots, originalFailurePreserved: true,
      failureCause: 'Harness read config before asynchronous library-choose completed; owned app close awaited pending writes and exact mode600 config is now persisted.' },
    otherPreservedAttempts: [
      { reportPath: path.join(output, 'local-native-1.6.0-20261004T130405385Z-verification.json'),
        reason: 'Correct BUSY lock: harness opened two local stores over its own clone concurrently; writer UI was moved to separate empty library.' },
      { reportPath: path.join(output, 'local-native-1.6.0-20261004T131333713Z-verification.json'),
        reason: 'Picker did not run before gallery portrait-media operations drained; evidence has no actual IPC trace, so no product defect is inferred. Narrow continuation waited image.decode and recorded actual IPC.' }
    ],
    restartedConfig: { exactVersionRootOnly: true, version: 1, root: library, mode: '600', sha256: sha(configBefore) },
    checks, errors, application: processInfo,
    screenshot: fs.existsSync(screenshotPath) ? { path: screenshotPath, actualWidth: 1440, actualHeight: 920,
      mechanism: 'Playwright renderer viewport1440x920; actual macOS content bounds separately recorded.' } : undefined,
    finalCount: status === 'passed' ? 100 : undefined, finalRevision: status === 'passed' ? 6 : undefined,
    temporaryPersistentTreeUnchanged: status === 'passed' ? true : undefined,
    noBusinessMock: true, noPickerOrClipboardSubstitutionInThisContinuation: true,
    error: failure }, null, 2)}\n`);
}
async function snapshot() {
  const response = await page.evaluate(() => window.portraitStudio.libraryList());
  expect(response.ok, JSON.stringify(response)).toBe(true); return response.data;
}
(async () => {
  try {
    save(); stage = 'restart-real-source';
    const env = { ...process.env, PORTRAIT_STUDIO_USER_DATA_DIR: profile };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTRAIT_STUDIO_REMOTE_BASE_URL', 'PORTRAIT_STUDIO_REMOTE_AUTHORIZATION', 'PORTRAIT_STUDIO_BACKEND', 'PORTRAIT_STUDIO_LIBRARY_DIR']) delete env[key];
    app = await electron.launch({ executablePath: require('electron'), args: [project], env });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 920 });
    processInfo = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0], preferences = window.webContents.getLastWebPreferences();
      globalThis.__localRestartNetwork = [];
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        globalThis.__localRestartNetwork.push({ scheme: new URL(details.url).protocol, resourceType: details.resourceType }); callback({ cancel: true });
      });
      const requireMain = process.getBuiltinModule('module').createRequire(process.cwd() + '/main.js');
      return { pid: process.pid, closed: false, userData: app.getPath('userData'), packaged: app.isPackaged,
        nativeContentBounds: window.getContentBounds(), contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration, sandbox: preferences.sandbox, webSecurity: preferences.webSecurity,
        remoteModulesLoaded: Object.keys(requireMain.cache).some(file => /\/(?:remote-electron|remote-client|auth-dialog)\.cjs$/.test(file)) };
    });
    expect(processInfo.userData).toBe(profile); expect(processInfo.packaged).toBe(false);
    expect(processInfo.contextIsolation).toBe(true); expect(processInfo.nodeIntegration).toBe(false);
    expect(processInfo.sandbox).toBe(true); expect(processInfo.webSecurity).toBe(true); expect(processInfo.remoteModulesLoaded).toBe(false);
    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.evaluate(() => window.portraitStudio.backend)).toBe('local');
    await expect(page.locator('.portrait-card')).toHaveCount(100, { timeout: 30000 });
    const restarted = await snapshot(); expect(restarted.root).toBe(library); expect(restarted.backend).toBe('local');
    expect(restarted.items).toHaveLength(100); expect(restarted.revision).toBe(6);
    for (const item of privateIndex.items) {
      const current = restarted.items.find(value => value.id === item.id); expect(current).toBeDefined();
      expect(current.prompts).toEqual(item.prompts); expect(current.sourceMetadata).toEqual(item.sourceMetadata);
      expect(current.sourceImport).toEqual(item.sourceImport); expect(current.imageRel).toBe(item.imageRel);
      expect(sha(ordinaryFile(path.join(library, current.imageRel)))).toBe(item.sha256);
    }
    checks.push('Actual production Electron loads saved local root without library env override:100 records/revision6; all persisted prompts, original metadata, source IDs, derived-translation provenance and100 PNG SHA match the owned raw index.');
    await expect(page.locator('#remoteConnectionDialog')).toHaveCount(0);
    // Only finish currently visible images for the final screenshot; all100
    // protocol decodes were already covered by the primary core run.
    await page.locator('.portrait-image').evaluateAll(async images => {
      const visible = images.filter(image => { const r = image.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      await Promise.all(visible.map(image => image.decode()));
    });
    await page.mouse.move(0, 0); await page.screenshot({ path: screenshotPath, scale: 'css', animations: 'disabled' });
    expect(fingerprint(library)).toEqual(before); expect(ordinaryFile(configPath)).toEqual(configBefore);
    expect(await app.evaluate(() => globalThis.__localRestartNetwork)).toEqual([]); expect(errors).toEqual([]);
    checks.push('Saved profile remains exact version1/root-only mode600; temporary persistent library tree is unchanged after restart; no remote modules or observed HTTP/HTTPS requests; no credentials, picker, clipboard or business data substituted.');
    status = 'passed'; stage = 'complete';
  } catch (error) {
    status = 'failed'; failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
  } finally {
    if (app) {
      await app.close(); app = undefined;
      if (processInfo) {
        processInfo.closed = true;
        try { process.kill(processInfo.pid, 0); processInfo.processGone = false; }
        catch (error) { processInfo.processGone = error.code === 'ESRCH'; processInfo.processCheck = error.code; }
      }
    }
    if (status === 'passed') {
      try { expect(processInfo.processGone).toBe(true); expect(fingerprint(library)).toEqual(before); expect(ordinaryFile(configPath)).toEqual(configBefore); }
      catch (error) { status = 'failed'; failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
    }
    save(); console.log(JSON.stringify({ status, stage, reportPath, screenshotPath, checks: checks.length,
      finalCount: status === 'passed' ? 100 : undefined, finalRevision: status === 'passed' ? 6 : undefined, application: processInfo }));
  }
})();
