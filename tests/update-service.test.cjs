'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { UpdateService, UpdateError, compareVersions, parseManifest } = require('../update-service.cjs');

const BASE = { currentVersion: '1.4.0', platform: 'darwin', arch: 'arm64', bundleId: 'com.jie.portraitstudio' };
const PACKAGE_BYTES = Buffer.from('Only a mock ZIP fixture. Never executable or installed.');
const SHA = crypto.createHash('sha256').update(PACKAGE_BYTES).digest('hex');
const manifest = overrides => ({ version: '1.4.1', name: 'Portrait Studio 1.4.1', notes: '修复及更新说明',
  pub_date: '2026-10-03T08:00:00Z', packagePath: 'releases/new.zip', sha256: SHA,
  platform: BASE.platform, arch: BASE.arch, bundleId: BASE.bundleId, ...overrides });

async function fixture(t, overrides = {}, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'portrait-local-update-'));
  await fsp.mkdir(path.join(root, 'releases'));
  await fsp.writeFile(path.join(root, 'releases/new.zip'), PACKAGE_BYTES);
  await fsp.writeFile(path.join(root, 'updates.json'), JSON.stringify(manifest(overrides)));
  const calls = { verify: [], install: [], states: [] };
  const service = new UpdateService({ ...BASE,
    verifyPackage: async input => { calls.verify.push(input); return { verified: true, canInstall: true }; },
    installPackage: async input => { calls.install.push(input); },
    onState: state => calls.states.push(state), ...options });
  t.after(async () => { service.dispose(); await fsp.rm(root, { recursive: true, force: true }); });
  await service.configureLocalSource(root);
  return { root, service, calls };
}

function reason(state, code) { return state.reasons.some(item => item.code === code); }
function rejected(code) { return error => error instanceof UpdateError && error.code === code; }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('strict semver compares numeric components, prereleases and build metadata', () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0+build.2', '1.0.0+build.1'), 0);
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let index = 1; index < versions.length; index++) assert.equal(compareVersions(versions[index - 1], versions[index]), -1);
  assert.equal(compareVersions('1.0.0-99999999999999999999', '1.0.0-99999999999999999998'), 1);
  for (const bad of ['1.4', 'v1.4.0', '01.4.0', '1.0.0-01', '1.0.0.', '', null, '9007199254740992.0.0']) {
    assert.throws(() => compareVersions(bad, '1.4.0'), rejected('INVALID_MANIFEST'));
  }
});

test('manifest accepts only local relative ZIPs and matching platform, architecture and application', () => {
  assert.equal(parseManifest(manifest(), BASE).version, '1.4.1');
  for (const packagePath of ['../outside.zip', '/tmp/file.zip', 'a/../file.zip', 'a//file.zip', './file.zip',
    'a\\file.zip', 'https://user:password@example.com/file.zip', 'file:///tmp/file.zip', 'file.dmg', 'a\u0000.zip']) {
    assert.throws(() => parseManifest(manifest({ packagePath }), BASE), rejected('INVALID_PACKAGE_PATH'));
  }
  for (const [field, value, code] of [['platform', 'win32', 'PLATFORM_MISMATCH'], ['arch', 'x64', 'ARCH_MISMATCH'],
    ['bundleId', 'other.app', 'BUNDLE_ID_MISMATCH'], ['sha256', 'bad', 'INVALID_MANIFEST'],
    ['url', 'https://example.com/pkg.zip', 'INVALID_MANIFEST'], ['notes', {}, 'INVALID_MANIFEST'],
    ['pub_date', 'tomorrow', 'INVALID_MANIFEST'], ['size', -1, 'INVALID_MANIFEST']]) {
    assert.throws(() => parseManifest(manifest({ [field]: value }), BASE), rejected(code));
  }
});

test('default missing source is truly unavailable and check does not claim latest', async () => {
  const service = new UpdateService(BASE);
  try {
    const state = await service.check();
    assert.equal(state.status, 'unavailable');
    assert.equal(state.sourceRoot, '');
    assert.equal(state.canCheck, false);
    assert.equal(state.canDownload, false);
    assert.equal(state.canInstall, false);
    assert.equal(reason(state, 'SOURCE_NOT_CONFIGURED'), true);
    state.reasons[0].message = 'tampered';
    assert.notEqual(service.getStatus().reasons[0].message, 'tampered');
  } finally { service.dispose(); }
});

test('check is read-only; explicit stage and install retain an opaque update id and verified expectations', async t => {
  const { root, service, calls } = await fixture(t);
  const before = await fsp.readFile(path.join(root, 'releases/new.zip'));
  const state = await service.check();
  assert.equal(state.status, 'available');
  assert.equal(state.availableVersion, '1.4.1');
  assert.equal(state.releaseNotes, '修复及更新说明');
  assert.equal(state.sourceManifest, path.join(await fsp.realpath(root), 'updates.json'));
  assert.match(state.updateId, /^[0-9a-f-]{36}$/);
  assert.equal(state.canCheck, true);
  assert.equal(state.canDownload, true);
  assert.equal(state.canInstall, false);
  assert.equal(state.verified, false);
  assert.equal('packagePath' in state, false);
  assert.equal(reason(state, 'LOCAL_CHECKSUM_ONLY'), true);
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.install.length, 0);
  await assert.rejects(service.downloadAndStage({ updateId: state.updateId }), rejected('CONFIRMATION_REQUIRED'));
  await assert.rejects(service.downloadAndStage({ confirmed: true, updateId: 'wrong' }), rejected('STALE_UPDATE'));
  await assert.rejects(service.restartAndInstall({ confirmed: true, updateId: state.updateId }), rejected('UPDATE_NOT_READY'));

  const ready = await service.downloadAndStage({ confirmed: true, updateId: state.updateId });
  assert.equal(ready.status, 'downloaded');
  assert.equal(ready.verified, true);
  assert.equal(ready.canInstall, true);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.install.length, 0);
  assert.equal(calls.verify[0].packagePath, path.join(await fsp.realpath(root), 'releases/new.zip'));
  assert.equal(calls.verify[0].updateId, state.updateId);
  assert.deepEqual(calls.verify[0].expected, { version: '1.4.1', currentVersion: '1.4.0', sha256: SHA,
    platform: 'darwin', arch: 'arm64', bundleId: BASE.bundleId });
  assert.deepEqual(calls.states.find(item => item.status === 'downloading').progress, { indeterminate: true });
  assert.deepEqual(await fsp.readFile(path.join(root, 'releases/new.zip')), before);
  await assert.rejects(service.restartAndInstall({ confirmed: false, updateId: state.updateId }), rejected('CONFIRMATION_REQUIRED'));
  assert.equal(calls.install.length, 0);
  const installing = await service.restartAndInstall({ confirmed: true, updateId: state.updateId });
  assert.equal(installing.status, 'installing');
  assert.equal(installing.canInstall, false);
  assert.equal(calls.install.length, 1); // Only a mock callback; no real installer is imported.
  await assert.rejects(service.restartAndInstall({ confirmed: true, updateId: state.updateId }), rejected('BUSY'));
});

test('same and lower versions never prepare a downgrade or invoke verifier', async t => {
  for (const version of ['1.4.0', '1.3.9', '1.4.0-rc.1', '1.4.0+metadata']) {
    const { service, calls } = await fixture(t, { version });
    const state = await service.check();
    assert.equal(state.status, 'up-to-date');
    assert.equal(state.canDownload, false);
    assert.equal(state.updateId, undefined);
    assert.equal(calls.verify.length, 0);
  }
});

test('missing, malformed, oversized and unreadable manifests are errors rather than latest', async t => {
  const { root, service } = await fixture(t);
  await fsp.unlink(path.join(root, 'updates.json'));
  assert.equal(reason(await service.check(), 'READ_FAILED'), true);
  await fsp.writeFile(path.join(root, 'updates.json'), '{broken');
  assert.equal(reason(await service.check(), 'INVALID_MANIFEST'), true);
  await fsp.writeFile(path.join(root, 'updates.json'), Buffer.from([0xff, 0xfe]));
  assert.equal(reason(await service.check(), 'INVALID_MANIFEST'), true);
  await fsp.writeFile(path.join(root, 'updates.json'), ' '.repeat(65537));
  assert.equal(reason(await service.check(), 'MANIFEST_TOO_LARGE'), true);
});

test('source, manifest, directory and final package symlinks are rejected', async t => {
  const { root, service } = await fixture(t);
  const linkedSource = path.join(root, 'source-link');
  await fsp.symlink(root, linkedSource);
  await assert.rejects(service.configureLocalSource(linkedSource), rejected('INVALID_SOURCE'));
  await service.configureLocalSource(root);
  await fsp.rename(path.join(root, 'updates.json'), path.join(root, 'real-manifest.json'));
  await fsp.symlink('real-manifest.json', path.join(root, 'updates.json'));
  assert.equal(reason(await service.check(), 'INVALID_PACKAGE_PATH'), true);
  await fsp.unlink(path.join(root, 'updates.json'));
  await fsp.rename(path.join(root, 'real-manifest.json'), path.join(root, 'updates.json'));

  await fsp.rename(path.join(root, 'releases/new.zip'), path.join(root, 'releases/real.zip'));
  await fsp.symlink('real.zip', path.join(root, 'releases/new.zip'));
  assert.equal(reason(await service.check(), 'INVALID_PACKAGE_PATH'), true);
  await fsp.unlink(path.join(root, 'releases/new.zip'));
  await fsp.rename(path.join(root, 'releases/real.zip'), path.join(root, 'releases/new.zip'));
  await fsp.rename(path.join(root, 'releases'), path.join(root, 'real-releases'));
  await fsp.symlink('real-releases', path.join(root, 'releases'));
  assert.equal(reason(await service.check(), 'INVALID_PACKAGE_PATH'), true);
});

test('missing/empty package and a wrong platform do not become installable', async t => {
  const { root, service } = await fixture(t);
  await fsp.unlink(path.join(root, 'releases/new.zip'));
  assert.equal(reason(await service.check(), 'PACKAGE_NOT_FOUND'), true);
  await fsp.writeFile(path.join(root, 'releases/new.zip'), '');
  assert.equal(reason(await service.check(), 'PACKAGE_TOO_LARGE'), true);
  await fsp.writeFile(path.join(root, 'updates.json'), JSON.stringify(manifest({ arch: 'x64' })));
  assert.equal(reason(await service.check(), 'ARCH_MISMATCH'), true);
});

test('manifest or package mutation after check invalidates the old update id before verifier', async t => {
  const { root, service, calls } = await fixture(t);
  const first = await service.check();
  await fsp.writeFile(path.join(root, 'updates.json'), JSON.stringify(manifest({ notes: 'changed' })));
  const changedManifest = await service.downloadAndStage({ confirmed: true, updateId: first.updateId });
  assert.equal(reason(changedManifest, 'UPDATE_CHANGED'), true);
  assert.equal(changedManifest.updateId, undefined);
  assert.equal(calls.verify.length, 0);
  const second = await service.check();
  await fsp.writeFile(path.join(root, 'releases/new.zip'), 'different bytes');
  const changedPackage = await service.downloadAndStage({ confirmed: true, updateId: second.updateId });
  assert.equal(reason(changedPackage, 'UPDATE_CHANGED'), true);
  assert.equal(calls.verify.length, 0);
});

test('replacement of the selected source root or intermediate release directory fails closed', async t => {
  const one = await fixture(t);
  const first = await one.service.check();
  const priorRoot = `${one.root}-previous`;
  t.after(async () => { await fsp.rm(priorRoot, { recursive: true, force: true }); });
  await fsp.rename(one.root, priorRoot);
  await fsp.mkdir(one.root);
  await fsp.mkdir(path.join(one.root, 'releases'));
  await fsp.copyFile(path.join(priorRoot, 'updates.json'), path.join(one.root, 'updates.json'));
  await fsp.copyFile(path.join(priorRoot, 'releases/new.zip'), path.join(one.root, 'releases/new.zip'));
  assert.equal(reason(await one.service.downloadAndStage({ confirmed: true, updateId: first.updateId }), 'UPDATE_CHANGED'), true);
  assert.equal(one.calls.verify.length, 0);

  const two = await fixture(t);
  const second = await two.service.check();
  await fsp.rename(path.join(two.root, 'releases'), path.join(two.root, 'old-releases'));
  await fsp.mkdir(path.join(two.root, 'releases'));
  // Preserve the same file inode to prove that parent directory identity is pinned too.
  await fsp.rename(path.join(two.root, 'old-releases/new.zip'), path.join(two.root, 'releases/new.zip'));
  assert.equal(reason(await two.service.downloadAndStage({ confirmed: true, updateId: second.updateId }), 'UPDATE_CHANGED'), true);
  assert.equal(two.calls.verify.length, 0);
});

test('SHA-256 mismatch blocks verification and installation', async t => {
  const { service, calls } = await fixture(t, { sha256: '0'.repeat(64) });
  const state = await service.check();
  const failed = await service.downloadAndStage({ confirmed: true, updateId: state.updateId });
  assert.equal(failed.status, 'error');
  assert.equal(reason(failed, 'CHECKSUM_MISMATCH'), true);
  assert.equal(failed.verified, false);
  assert.equal(failed.canInstall, false);
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.install.length, 0);
});

test('Gatekeeper rejection remains a truthful verified but installation-blocked state', async t => {
  const { service } = await fixture(t, {}, { verifyPackage: async () => ({ verified: true, canInstall: false,
    reasons: [{ code: 'GATEKEEPER_REJECTED', message: 'macOS Gatekeeper 拒绝此安装包，升级已停止。' }] }) });
  const available = await service.check();
  const state = await service.downloadAndStage({ confirmed: true, updateId: available.updateId });
  assert.equal(state.status, 'downloaded');
  assert.equal(state.verified, true);
  assert.equal(state.canInstall, false);
  assert.equal(reason(state, 'GATEKEEPER_REJECTED'), true);
  await assert.rejects(service.restartAndInstall({ confirmed: true, updateId: state.updateId }), rejected('INSTALL_BLOCKED'));
});

test('wrong bundle/version/signature errors and unknown hook errors expose only safe messages', async t => {
  for (const code of ['BUNDLE_ID_MISMATCH', 'VERSION_MISMATCH', 'SIGNATURE_INVALID']) {
    const { service } = await fixture(t, {}, { verifyPackage: async () => { throw new UpdateError(code); } });
    const available = await service.check();
    const failed = await service.downloadAndStage({ confirmed: true, updateId: available.updateId });
    assert.equal(failed.verified, false);
    assert.equal(reason(failed, code), true);
  }
  const { service } = await fixture(t, {}, { verifyPackage: async () => { throw new Error('sensitive raw native error'); } });
  const available = await service.check();
  const failed = await service.downloadAndStage({ confirmed: true, updateId: available.updateId });
  assert.equal(reason(failed, 'VERIFICATION_FAILED'), true);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
  const installerTyped = await fixture(t, {}, { verifyPackage: async () => {
    const error = new Error('raw codesign response must not leave main'); error.code = 'INVALID_SIGNATURE'; throw error;
  } });
  const typedAvailable = await installerTyped.service.check();
  const typedFailed = await installerTyped.service.downloadAndStage({ confirmed: true, updateId: typedAvailable.updateId });
  assert.equal(reason(typedFailed, 'SIGNATURE_INVALID'), true);
  assert.equal(JSON.stringify(typedFailed).includes('codesign response'), false);
});

test('missing hooks are accurately represented and never claim install capability', async t => {
  const { service } = await fixture(t, {}, { verifyPackage: undefined, installPackage: undefined });
  const available = await service.check();
  assert.equal(available.canDownload, false);
  assert.equal(reason(available, 'VERIFIER_NOT_CONFIGURED'), true);
  await assert.rejects(service.downloadAndStage({ confirmed: true, updateId: available.updateId }), rejected('VERIFIER_NOT_CONFIGURED'));
  const withVerifier = await fixture(t, {}, { installPackage: undefined });
  const next = await withVerifier.service.check();
  const ready = await withVerifier.service.downloadAndStage({ confirmed: true, updateId: next.updateId });
  assert.equal(ready.verified, true);
  assert.equal(ready.canInstall, false);
  assert.equal(reason(ready, 'INSTALLER_NOT_CONFIGURED'), true);
});

test('concurrent operations are guarded; timeout ignores a late verification result', async t => {
  const gate = deferred();
  const entered = deferred();
  const { service } = await fixture(t, {}, { stageTimeoutMs: 30, verifyPackage: async () => {
    entered.resolve(); return gate.promise;
  } });
  const available = await service.check();
  const pending = service.downloadAndStage({ confirmed: true, updateId: available.updateId });
  await entered.promise;
  await assert.rejects(service.check(), rejected('BUSY'));
  await assert.rejects(service.downloadAndStage({ confirmed: true, updateId: available.updateId }), rejected('BUSY'));
  const failed = await pending;
  assert.equal(reason(failed, 'TIMEOUT'), true);
  gate.resolve({ verified: true, canInstall: true });
  await Promise.resolve();
  assert.equal(service.getStatus().verified, false);
  assert.equal(service.getStatus().canInstall, false);
});

test('changing source aborts old work and stale callback cannot restore old state', async t => {
  const gate = deferred();
  const entered = deferred();
  const { service, root } = await fixture(t, {}, { verifyPackage: async () => { entered.resolve(); return gate.promise; } });
  const other = path.join(root, 'other');
  await fsp.mkdir(other);
  await fsp.writeFile(path.join(other, 'updates.json'), JSON.stringify(manifest({ version: '1.4.0' })));
  const available = await service.check();
  const pending = service.downloadAndStage({ confirmed: true, updateId: available.updateId });
  await entered.promise;
  const next = await service.configureLocalSource(other);
  assert.equal(next.status, 'idle');
  await pending;
  gate.resolve({ verified: true, canInstall: true });
  await Promise.resolve();
  assert.equal(service.getStatus().status, 'idle');
  assert.equal(service.getStatus().updateId, undefined);
  assert.equal(service.getStatus().sourceRoot, await fsp.realpath(other));
  await assert.rejects(service.restartAndInstall({ confirmed: true, updateId: available.updateId }), rejected('STALE_UPDATE'));
});

test('dispose cancels pending verifier and never performs automatic installation', async t => {
  const gate = deferred();
  const entered = deferred();
  let installed = 0;
  const { service } = await fixture(t, {}, { verifyPackage: async () => { entered.resolve(); return gate.promise; },
    installPackage: async () => { installed++; } });
  const available = await service.check();
  const pending = service.downloadAndStage({ confirmed: true, updateId: available.updateId });
  await entered.promise;
  service.dispose();
  await pending;
  gate.resolve({ verified: true, canInstall: true });
  await Promise.resolve();
  assert.equal(reason(service.getStatus(), 'DISPOSED'), true);
  assert.equal(service.getStatus().verified, false);
  assert.equal(installed, 0);
  await assert.rejects(service.check(), rejected('DISPOSED'));
});

test('installer dispatch failure stays retryable and does not report an installed version', async t => {
  const { service } = await fixture(t, {}, { installPackage: async () => { throw new Error('private helper stdout'); } });
  const available = await service.check();
  await service.downloadAndStage({ confirmed: true, updateId: available.updateId });
  const failed = await service.restartAndInstall({ confirmed: true, updateId: available.updateId });
  assert.equal(failed.status, 'error');
  assert.equal(failed.currentVersion, '1.4.0');
  assert.equal(failed.canInstall, true);
  assert.equal(reason(failed, 'INSTALL_FAILED'), true);
  assert.equal(JSON.stringify(failed).includes('stdout'), false);
});
