'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RemoteError, validateEndpoint } = require('./remote-client.cjs');

const RECOMMENDED_ENDPOINT = 'https://dashboard-18-180-65-241.sslip.io/portrait-studio/';
const FILE_NAME = 'remote-connection.json';
const fail = code => { throw new RemoteError(code); };
const same = (stat, expected) => stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs;
function canonicalEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) fail('INVALID_REMOTE_ENDPOINT');
  let candidate = value.trim(); if (!candidate.endsWith('/')) candidate += '/';
  try { const result = validateEndpoint(candidate); if (result.transport !== 'https') fail('INVALID_REMOTE_ENDPOINT'); return result.endpoint; }
  catch { fail('INVALID_REMOTE_ENDPOINT'); }
}
async function lstat(filename) { return fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); }
async function directoryPins(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f\\]/.test(directory) || directory.split(path.sep).some(part => part === '.' || part === '..')) fail('INVALID_REMOTE_CONFIG');
  const pins = []; let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let stat = await lstat(current);
    if (!stat) {
      if (!create) return null;
      for (const pin of pins) { const now = await lstat(pin.path); if (!now?.isDirectory() || now.isSymbolicLink() || now.dev !== pin.dev || now.ino !== pin.ino) fail('INVALID_REMOTE_CONFIG'); }
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); stat = await lstat(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('INVALID_REMOTE_CONFIG');
    pins.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  if (!pins.length || await fs.realpath(directory) !== directory) fail('INVALID_REMOTE_CONFIG'); return pins;
}
async function assertPins(pins) {
  for (const pin of pins) { const now = await lstat(pin.path); if (!now?.isDirectory() || now.isSymbolicLink() || now.dev !== pin.dev || now.ino !== pin.ino) fail('INVALID_REMOTE_CONFIG'); }
}
async function readRemoteConfiguration(directory) {
  const pins = await directoryPins(directory); if (!pins) return null;
  const filename = path.join(directory, FILE_NAME), before = await lstat(filename); if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16384 || (before.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) fail('INVALID_REMOTE_CONFIG');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = await handle.stat(); if (!same(stat, before)) fail('INVALID_REMOTE_CONFIG');
    bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) fail('INVALID_REMOTE_CONFIG'); offset += result.bytesRead; }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (extra.bytesRead || !same(await handle.stat(), before)) fail('INVALID_REMOTE_CONFIG');
  } finally { await handle.close(); }
  await assertPins(pins); const after = await lstat(filename); if (!after || after.isSymbolicLink() || !same(after, before)) fail('INVALID_REMOTE_CONFIG');
  let value;
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Accept only the two literal keys written by this module. This also rejects
    // duplicate or escaped-key aliases instead of overwriting unknown user data.
    const shape = /^\s*\{\s*"(version|endpoint)"\s*:\s*(1|"(?:[^"\\]|\\.)*")\s*,\s*"(version|endpoint)"\s*:\s*(1|"(?:[^"\\]|\\.)*")\s*\}\s*$/s.exec(raw);
    if (!shape || shape[1] === shape[3]) fail('INVALID_REMOTE_CONFIG');
    value = JSON.parse(raw);
  } catch { fail('INVALID_REMOTE_CONFIG'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Object.hasOwn(value, 'endpoint')) fail('INVALID_REMOTE_CONFIG');
  let endpoint; try { endpoint = canonicalEndpoint(value.endpoint); } catch { fail('INVALID_REMOTE_CONFIG'); }
  return { endpoint };
}
async function writeRemoteConfiguration(directory, endpoint) {
  const canonical = canonicalEndpoint(endpoint), pins = await directoryPins(directory, true), filename = path.join(directory, FILE_NAME), before = await lstat(filename);
  if (before) { await readRemoteConfiguration(directory); const current = await lstat(filename); if (!current || current.isSymbolicLink() || !same(current, before)) fail('INVALID_REMOTE_CONFIG'); }
  const temporary = path.join(directory, `.remote-connection-${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx', 0o600);
  const temporaryPin = await handle.stat();
  try {
    try { await handle.writeFile(JSON.stringify({ version: 1, endpoint: canonical }) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await assertPins(pins); const now = await lstat(filename);
    if (before ? !now || now.isSymbolicLink() || !same(now, before) : now !== null) fail('INVALID_REMOTE_CONFIG');
    await fs.rename(temporary, filename);
    const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    const current = await lstat(temporary);
    if (current?.isFile() && !current.isSymbolicLink() && current.dev === temporaryPin.dev && current.ino === temporaryPin.ino) await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return { endpoint: canonical };
}

module.exports = { RECOMMENDED_ENDPOINT, FILE_NAME, canonicalEndpoint, readRemoteConfiguration, writeRemoteConfiguration };
