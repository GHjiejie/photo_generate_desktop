const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalUpdateInstaller, compareVersions, runInstallPlan, recoverInstallPlan, registerLaunch, acknowledgeLaunch } = require('../local-update-installer.cjs');

const NAME = 'Portrait Studio.app', BUNDLE = 'com.jie.portraitstudio';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc(bytes) { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ c >>> 8; return (c ^ 0xffffffff) >>> 0; }
function zip(entries, extra = Buffer.alloc(0)) {
  const locals = [], centrals = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || ''), checksum = crc(data), mode = entry.mode || (entry.name.endsWith('/') ? 0o40755 : 0o100644);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    locals.push(local, name, extra, data);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra); offset += local.length + name.length + extra.length + data.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function bundleEntries(version, bundleId = BUNDLE, architecture = 0x0100000c) {
  const binary = Buffer.alloc(48); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(architecture, 4); binary.write(version, 32);
  return [
    ...[`${NAME}/`, `${NAME}/Contents/`, `${NAME}/Contents/MacOS/`, `${NAME}/Contents/Resources/`].map(name => ({ name })),
    { name: `${NAME}/Contents/Info.plist`, data: JSON.stringify({ CFBundleIdentifier: bundleId, CFBundleShortVersionString: version, CFBundleExecutable: 'Portrait Studio' }) },
    { name: `${NAME}/Contents/MacOS/Portrait Studio`, data: binary, mode: 0o100755 },
    { name: `${NAME}/Contents/Resources/app.asar`, data: `isolated fake application ${version}` },
  ];
}
async function writeEntries(root, entries) {
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.name.endsWith('/')) await fs.mkdir(file, { recursive: true });
    else { await fs.mkdir(path.dirname(file), { recursive: true }); if ((entry.mode & 0o170000) === 0o120000) await fs.symlink(entry.data, file); else await fs.writeFile(file, entry.data, { mode: (entry.mode || 0o100644) & 0o777 }); }
  }
}
async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-update-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'current'), incoming = path.join(root, 'incoming'); await fs.mkdir(current); await fs.mkdir(incoming);
  const oldEntries = bundleEntries('1.3.0'), newEntries = bundleEntries(changes.version || '1.4.0', changes.bundleId || BUNDLE, changes.architecture);
  await writeEntries(current, oldEntries); await writeEntries(incoming, newEntries);
  const zipPath = path.join(root, 'release.zip'), bytes = zip(changes.entries || newEntries, changes.extra);
  await fs.writeFile(zipPath, bytes);
  const hooks = { verifier: async () => ({ signatureValid: true, gatekeeperAllowed: changes.allowed !== false }), extractor: async (_zip, destination) => fs.cp(path.join(incoming, NAME), path.join(destination, NAME), { recursive: true, verbatimSymlinks: true }), skipQuarantineRead: true, waitForExit: async () => {}, handoff: async value => ({ started: true, ...value }), ...changes.hooks };
  const targetAppPath = path.join(current, NAME), installer = new LocalUpdateInstaller({ targetAppPath, currentVersion: '1.3.0', bundleId: BUNDLE, testHooks: hooks });
  const input = { zipPath, sha256: sha(bytes), targetVersion: '1.4.0', currentVersion: '1.3.0', bundleId: BUNDLE, arch: 'arm64' };
  return { root, current, incoming, targetAppPath, installer, hooks, input, newEntries };
}
const rejects = (call, code) => assert.rejects(call, error => { assert.equal(error.code, code, error.stack); return true; });
const info = async app => JSON.parse(await fs.readFile(path.join(app, 'Contents/Info.plist'), 'utf8'));
const state = async plan => JSON.parse(await fs.readFile(path.join(plan.stageRoot, 'state.json'), 'utf8'));
async function handedOff(f) { const plan = await f.installer.prepare(f.input); await f.installer.handoff({ planPath: plan.planPath, parentPid: process.pid, confirmed: true }); return plan; }

test('strict semver includes prerelease ordering and rejects malformed versions', () => {
  assert.equal(compareVersions('1.4.0', '1.3.9'), 1); assert.equal(compareVersions('1.4.0', '1.4.0-beta.9'), 1);
  assert.equal(compareVersions('1.4.0-beta.10', '1.4.0-beta.9'), 1); assert.equal(compareVersions('1.4.0+one', '1.4.0+two'), 0);
  for (const value of ['v1.4.0', '1.4', '01.4.0', '1.4.0-01', '1.4.0/../../']) assert.throws(() => compareVersions(value, '1.3.0'), { code: 'INVALID_VERSION' });
});
test('preparing verifies and copies privately without replacing an app or modifying its profile', async t => {
  const f = await fixture(t), profile = path.join(f.root, 'profile'); await fs.mkdir(profile); await fs.writeFile(path.join(profile, 'sentinel'), 'private data');
  const prepared = await f.installer.prepare(f.input); assert.equal(prepared.verified, true); assert.equal(prepared.canInstall, true);
  assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0'); assert.equal((await state(prepared)).status, 'prepared');
  assert.equal((await fs.stat(prepared.stageRoot)).mode & 0o777, 0o700); assert.ok((await fs.readFile(path.join(prepared.stageRoot, 'install-helper.cjs'))).length > 1000);
  await fs.writeFile(f.input.zipPath, 'source changed after private copy'); assert.equal(sha(await fs.readFile(path.join(prepared.stageRoot, 'release.zip'))), f.input.sha256);
  await rejects(() => f.installer.handoff({ planPath: prepared.planPath }), 'CONFIRMATION_REQUIRED');
  assert.equal(await fs.readFile(path.join(profile, 'sentinel'), 'utf8'), 'private data');
  await f.installer.disposePlan(prepared.planPath); await assert.rejects(fs.access(prepared.stageRoot), { code: 'ENOENT' });
});
test('Gatekeeper rejection remains verified but cannot hand off, quit or replace', async t => {
  const f = await fixture(t, { allowed: false }); const prepared = await f.installer.prepare(f.input);
  assert.equal(prepared.verified, true); assert.equal(prepared.canInstall, false); assert.equal(prepared.reasons[0].code, 'GATEKEEPER_REJECTED');
  await rejects(() => f.installer.handoff({ planPath: prepared.planPath, confirmed: true }), 'GATEKEEPER_REJECTED');
  assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0'); assert.equal((await state(prepared)).status, 'blocked');
});
test('formally signed current apps only accept the same Team ID', async t => {
  const f = await fixture(t, { hooks: { verifier: async app => ({ signatureValid: true, gatekeeperAllowed: true, teamIdentifier: (await info(app)).CFBundleShortVersionString === '1.3.0' ? 'TEAMONE123' : 'TEAMTWO123' }) } });
  await rejects(() => f.installer.prepare(f.input), 'WRONG_SIGNER');
  const good = await fixture(t, { hooks: { verifier: async () => ({ signatureValid: true, gatekeeperAllowed: true, teamIdentifier: 'TEAMONE123' }) } });
  const prepared = await good.installer.prepare(good.input); assert.equal(prepared.publisherAuthenticated, true);
  assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0');
});
test('checksum, identity, version and architecture failures never replace the target', async t => {
  const f = await fixture(t); await rejects(() => f.installer.prepare({ ...f.input, sha256: '0'.repeat(64) }), 'CHECKSUM_MISMATCH');
  await rejects(() => f.installer.prepare({ ...f.input, targetVersion: '1.3.0' }), 'NOT_NEWER');
  await rejects(() => f.installer.prepare({ ...f.input, currentVersion: '1.2.0' }), 'VERSION_MISMATCH');
  const wrong = await fixture(t, { bundleId: 'com.other.application' }); await rejects(() => wrong.installer.prepare(wrong.input), 'WRONG_BUNDLE');
  const wrongVersion = await fixture(t, { version: '1.5.0' }); await rejects(() => wrongVersion.installer.prepare(wrongVersion.input), 'VERSION_MISMATCH');
  const wrongArch = await fixture(t, { architecture: 0x01000007 }); await rejects(() => wrongArch.installer.prepare(wrongArch.input), 'WRONG_ARCH');
  assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0');
});
for (const [label, malicious] of [
  ['traversal', { name: `${NAME}/../../escape`, data: 'bad' }],
  ['absolute', { name: '/tmp/escape', data: 'bad' }],
  ['symlink escape', { name: `${NAME}/Contents/Frameworks/Evil.framework/Resources`, data: '../../../../../../escape', mode: 0o120777 }],
  ['case collision', { name: `${NAME}/Contents/INFO.PLIST`, data: 'duplicate' }],
]) test(`ZIP rejects ${label} before extraction`, async t => {
  const f = await fixture(t, { entries: [...bundleEntries('1.4.0'), malicious] }); await rejects(() => f.installer.prepare(f.input), 'UNSAFE_PACKAGE');
  assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0');
});
test('ZIP rejects alternate Unicode-path extra semantics and source directory links', async t => {
  const extra = Buffer.alloc(9); extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5, 2); extra[4] = 1;
  const f = await fixture(t, { extra }); await rejects(() => f.installer.prepare(f.input), 'UNSAFE_PACKAGE');
  const good = await fixture(t), alias = path.join(good.root, 'source-link'); await fs.symlink(good.root, alias);
  await rejects(() => good.installer.prepare({ ...good.input, zipPath: path.join(alias, 'release.zip') }), 'UNSAFE_PATH');
});
test('only safe existing internal framework links are accepted', async t => {
  const framework = `${NAME}/Contents/Frameworks/Safe.framework`;
  const additions = [
    ...[`${NAME}/Contents/Frameworks/`, `${framework}/`, `${framework}/Versions/`, `${framework}/Versions/A/`, `${framework}/Versions/A/Resources/`].map(name => ({ name })),
    { name: `${framework}/Versions/A/Resources/data`, data: 'safe' },
    { name: `${framework}/Versions/Current`, data: 'A', mode: 0o120777 },
    { name: `${framework}/Resources`, data: 'Versions/Current/Resources', mode: 0o120777 },
  ];
  const f = await fixture(t, { entries: [...bundleEntries('1.4.0'), ...additions] }); await writeEntries(f.incoming, additions);
  const prepared = await f.installer.prepare(f.input); assert.equal(prepared.canInstall, true);
});
test('handoff revalidates staged content and current app instead of trusting the first scan', async t => {
  const f = await fixture(t), plan = await f.installer.prepare(f.input);
  await fs.writeFile(path.join(plan.stageRoot, 'extracted', NAME, 'Contents/Resources/app.asar'), 'tampered');
  await rejects(() => f.installer.handoff({ planPath: plan.planPath, confirmed: true }), 'CONFLICT');
  const g = await fixture(t), second = await g.installer.prepare(g.input); await fs.writeFile(path.join(g.targetAppPath, 'Contents/Resources/app.asar'), 'external edit');
  await rejects(() => g.installer.handoff({ planPath: second.planPath, confirmed: true }), 'CONFLICT');
});
test('filesystem replacement completes only after registered new version and renderer acknowledgment', async t => {
  const f = await fixture(t), plan = await handedOff(f), calls = [];
  const launcher = async (appPath, planPath) => {
    calls.push((await info(appPath)).CFBundleShortVersionString);
    const launch = { argv: [`--portrait-update-ack=${planPath}`], appPath, version: '1.4.0' };
    assert.equal((await registerLaunch(launch)).registered, true); assert.equal((await acknowledgeLaunch(launch)).acknowledged, true);
  };
  const result = await runInstallPlan(plan.planPath, { parentPid: process.pid, testHooks: { ...f.hooks, launcher } });
  assert.equal(result.installed, true); assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.4.0');
  assert.equal((await info(result.backupPath)).CFBundleShortVersionString, '1.3.0'); assert.deepEqual(calls, ['1.4.0']); assert.equal((await state(plan)).status, 'completed');
});
test('failed native launch restores and relaunches the previous application', async t => {
  const f = await fixture(t), plan = await handedOff(f), calls = [];
  const launcher = async (appPath, planPath) => { calls.push((await info(appPath)).CFBundleShortVersionString); if (planPath) throw new Error('isolated launch failure'); };
  await assert.rejects(runInstallPlan(plan.planPath, { parentPid: process.pid, testHooks: { ...f.hooks, launcher } }), /isolated launch failure/);
  assert.deepEqual(calls, ['1.4.0', '1.3.0']); assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0'); assert.equal((await state(plan)).status, 'rolled-back');
});
test('unacknowledged registered startup is stopped through a scoped test hook before rollback', async t => {
  const f = await fixture(t), plan = await handedOff(f), events = [];
  const launcher = async (appPath, planPath) => { events.push(`launch ${(await info(appPath)).CFBundleShortVersionString}`); if (planPath) await registerLaunch({ argv: [`--portrait-update-ack=${planPath}`], appPath, version: '1.4.0' }); };
  const stopUnconfirmed = async registration => { assert.equal(registration.appPath, await fs.realpath(f.targetAppPath)); events.push('stop registered PID'); };
  await rejects(() => runInstallPlan(plan.planPath, { parentPid: process.pid, testHooks: { ...f.hooks, launcher, stopUnconfirmed, confirmationTimeoutMs: 50 } }), 'STARTUP_TIMEOUT');
  assert.deepEqual(events, ['launch 1.4.0', 'stop registered PID', 'launch 1.3.0']); assert.equal((await state(plan)).status, 'rolled-back');
});
test('missing startup identity blocks rollback relaunch rather than creating a second instance', async t => {
  const f = await fixture(t), plan = await handedOff(f), calls = [];
  await rejects(() => runInstallPlan(plan.planPath, { parentPid: process.pid, testHooks: { ...f.hooks, launcher: async (_app, planPath) => calls.push(Boolean(planPath)), confirmationTimeoutMs: 50 } }), 'ROLLBACK_FAILED');
  assert.deepEqual(calls, [true]); assert.equal((await state(plan)).status, 'rollback-blocked');
  assert.equal((await info(path.join(plan.stageRoot, 'previous.app'))).CFBundleShortVersionString, '1.3.0');
});
for (const phase of ['after-backup', 'after-replace']) test(`interrupted helper at ${phase} can recover the original app without userData changes`, async t => {
  const f = await fixture(t), plan = await handedOff(f), profile = path.join(f.root, 'profile.json'); await fs.writeFile(profile, '{"private":true}');
  const fault = async at => { if (at === phase) { const error = new Error('simulated crash'); error.crash = true; throw error; } };
  await assert.rejects(runInstallPlan(plan.planPath, { parentPid: process.pid, testHooks: { ...f.hooks, fault } }), /simulated crash/);
  const calls = [], result = await recoverInstallPlan(plan.planPath, { testHooks: { ...f.hooks, launcher: async app => calls.push((await info(app)).CFBundleShortVersionString) } });
  assert.equal(result.recovered, true); assert.equal((await info(f.targetAppPath)).CFBundleShortVersionString, '1.3.0'); assert.deepEqual(calls, ['1.3.0']);
  assert.equal(await fs.readFile(profile, 'utf8'), '{"private":true}'); assert.equal((await state(plan)).status, 'rolled-back');
});
test('startup acknowledgment rejects arbitrary plan paths, wrong version and wrong fixed app', async t => {
  const f = await fixture(t), plan = await handedOff(f);
  assert.deepEqual(await acknowledgeLaunch({ argv: [], appPath: f.targetAppPath, version: '1.3.0' }), { acknowledged: false });
  await rejects(() => acknowledgeLaunch({ argv: [`--portrait-update-ack=${plan.planPath}`], appPath: f.targetAppPath, version: '1.3.0' }), 'INVALID_ACK');
  await assert.rejects(acknowledgeLaunch({ argv: ['--portrait-update-ack=/tmp/not-owned/plan.json'], appPath: f.targetAppPath, version: '1.4.0' }));
});
