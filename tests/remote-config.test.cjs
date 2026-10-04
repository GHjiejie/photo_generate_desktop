'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FILE_NAME, RECOMMENDED_ENDPOINT, canonicalEndpoint, readRemoteConfiguration, writeRemoteConfiguration } = require('../remote-config.cjs');

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-remote-config-'))), profile = path.join(base, 'profile');
  t.after(() => fs.rm(base, { recursive: true, force: true })); return { base, profile, file: path.join(profile, FILE_NAME) };
}
test('settings contain only a canonical HTTPS endpoint and a missing profile is read without creating files', async t => {
  const f = await fixture(t); assert.equal(await readRemoteConfiguration(f.profile), null); assert.deepEqual(await fs.readdir(f.base), []);
  assert.equal(canonicalEndpoint(' https://server.invalid/portrait-studio '), 'https://server.invalid/portrait-studio/'); assert.equal(canonicalEndpoint('https://server.invalid'), 'https://server.invalid/');
  for (const endpoint of ['http://127.0.0.1:8000/', 'https://user:secret@server.invalid/', 'https://server.invalid/?token=x', 'https://server.invalid/#password', 'https://server.invalid/a/../b/', 'https://server.invalid/%2e%2e/', 'file:///etc/passwd']) assert.throws(() => canonicalEndpoint(endpoint), error => error.code === 'INVALID_REMOTE_ENDPOINT');
  assert.equal(RECOMMENDED_ENDPOINT, 'https://dashboard-18-180-65-241.sslip.io/portrait-studio/');
});
test('saving and replacing valid settings is atomic, private, restart-readable and contains no auth fields', async t => {
  const f = await fixture(t); await writeRemoteConfiguration(f.profile, RECOMMENDED_ENDPOINT);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), { version: 1, endpoint: RECOMMENDED_ENDPOINT });
  const old = await fs.stat(f.file); await writeRemoteConfiguration(f.profile, 'https://another.invalid/library/'); assert.notEqual((await fs.stat(f.file)).ino, old.ino);
  assert.deepEqual(await readRemoteConfiguration(f.profile), { endpoint: 'https://another.invalid/library/' }); assert.deepEqual(await fs.readdir(f.profile), [FILE_NAME]);
});
test('unknown, malformed, duplicate-key, credential-bearing, oversized and insecure existing files are preserved', async t => {
  const variants = [
    ['{"version":2,"endpoint":"https://old.invalid/"}', 0o600],
    ['{"version":1,"endpoint":"https://old.invalid/","password":"fake-only-test"}', 0o600],
    ['{"version":1,"endpoint":"https://fake:fake@old.invalid/","endpoint":"https://old.invalid/"}', 0o600],
    ['{"version":1,"end\\u0070oint":"https://old.invalid/"}', 0o600],
    ['{malformed', 0o600], ['x'.repeat(16385), 0o600], ['{"version":1,"endpoint":"https://old.invalid/"}', 0o644]
  ];
  for (const [raw, mode] of variants) {
    const f = await fixture(t); await fs.mkdir(f.profile); await fs.writeFile(f.file, raw, { mode });
    await assert.rejects(readRemoteConfiguration(f.profile), error => error.code === 'INVALID_REMOTE_CONFIG');
    await assert.rejects(writeRemoteConfiguration(f.profile, RECOMMENDED_ENDPOINT), error => error.code === 'INVALID_REMOTE_CONFIG');
    assert.equal(await fs.readFile(f.file, 'utf8'), raw); assert.deepEqual(await fs.readdir(f.profile), [FILE_NAME]);
  }
});
test('symlink files, hard links and symlink profile ancestors cannot be used or overwritten', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = await fixture(t); await fs.mkdir(f.profile); const target = path.join(f.base, 'unrelated.json'), raw = JSON.stringify({ version: 1, endpoint: 'https://old.invalid/' }); await fs.writeFile(target, raw, { mode: 0o600 });
    if (kind === 'symlink') await fs.symlink(target, f.file); else await fs.link(target, f.file);
    await assert.rejects(readRemoteConfiguration(f.profile), error => error.code === 'INVALID_REMOTE_CONFIG'); await assert.rejects(writeRemoteConfiguration(f.profile, RECOMMENDED_ENDPOINT), error => error.code === 'INVALID_REMOTE_CONFIG'); assert.equal(await fs.readFile(target, 'utf8'), raw);
  }
  const f = await fixture(t); await fs.mkdir(f.profile); const alias = path.join(f.base, 'profile-alias'); await fs.symlink(f.profile, alias);
  await assert.rejects(writeRemoteConfiguration(alias, RECOMMENDED_ENDPOINT), error => error.code === 'INVALID_REMOTE_CONFIG'); assert.deepEqual(await fs.readdir(f.profile), []);
});
test('a failed temporary write preserves the existing settings and removes only its owned temporary file', async t => {
  const f = await fixture(t); await writeRemoteConfiguration(f.profile, 'https://old.invalid/'); const before = await fs.readFile(f.file), open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (!String(args[0]).includes('.remote-connection-')) return handle;
    return { stat: () => handle.stat(), writeFile: async () => { throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' }); }, sync: () => handle.sync(), close: () => handle.close() };
  };
  try { await assert.rejects(writeRemoteConfiguration(f.profile, RECOMMENDED_ENDPOINT), error => error.code === 'EIO'); } finally { fs.open = open; }
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await fs.readdir(f.profile), [FILE_NAME]);
});
