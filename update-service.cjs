'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_NAME = 'updates.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const INTEGRITY_REASON = Object.freeze({
  code: 'LOCAL_CHECKSUM_ONLY',
  message: 'SHA-256 来自同一更新目录，仅校验完整性，不能独立确认发布者身份。'
});
const MESSAGES = Object.freeze({
  SOURCE_NOT_CONFIGURED: '请选择包含 updates.json 和 ZIP 安装包的本地更新目录。',
  INVALID_SOURCE: '更新来源必须是可读取的本地目录。',
  INVALID_MANIFEST: '版本文档格式无效，请检查 updates.json。',
  MANIFEST_TOO_LARGE: '版本文档超过允许的大小。',
  INVALID_PACKAGE_PATH: '安装包必须位于所选目录内，不能使用链接或越界路径。',
  PACKAGE_NOT_FOUND: '版本文档指定的 ZIP 安装包不存在或无法读取。',
  PACKAGE_TOO_LARGE: '安装包为空或超过允许的大小。',
  PLATFORM_MISMATCH: '此更新包不适用于当前操作系统。',
  ARCH_MISMATCH: '此更新包不适用于当前处理器架构。',
  BUNDLE_ID_MISMATCH: '此更新包的应用标识不匹配。',
  VERSION_MISMATCH: '安装包内的应用版本与版本文档不匹配。',
  UPDATE_CHANGED: '更新来源在检查后发生变化，请重新检查。',
  CHECKSUM_MISMATCH: '安装包 SHA-256 校验失败，请核对来源或重新取得安装包。',
  VERIFIER_NOT_CONFIGURED: '当前应用未配置安装包验证器。',
  INSTALLER_NOT_CONFIGURED: '当前应用未配置安全安装器。',
  VERIFICATION_FAILED: '安装包验证失败，未准备安装。',
  SIGNATURE_INVALID: '安装包的代码签名完整性验证失败。',
  GATEKEEPER_REJECTED: 'macOS Gatekeeper 拒绝此安装包，升级已停止。',
  INSTALL_BLOCKED: '安装包已校验，但当前条件不允许安装。',
  INSTALL_FAILED: '升级启动失败，应用尚未确认完成升级。',
  CONFIRMATION_REQUIRED: '此操作需要明确确认。',
  STALE_UPDATE: '更新标识已过期，请重新检查更新。',
  UPDATE_NOT_READY: '请先准备并校验更新包。',
  BUSY: '已有更新操作正在进行。',
  TIMEOUT: '更新操作超时，请重试。',
  CANCELLED: '更新操作已取消。',
  DISPOSED: '更新服务已关闭。',
  READ_FAILED: '无法读取本地更新来源，请检查目录权限。',
  READ_ONLY: '当前应用位于只读或不可写目录，请先放到可写位置。',
  INVALID_PACKAGE: '更新 ZIP 的结构或内容无效。',
  UNSAFE_PACKAGE: '更新 ZIP 包含不安全的路径或文件。',
  INVALID_BUNDLE: '更新包中的应用信息无效。',
  INVALID_PLAN: '暂存更新计划无效，请重新准备更新。',
  UPDATE_CONFIGURATION_INVALID: '保存的更新来源配置无效，请重新选择目录。',
  UPDATE_DEVELOPMENT_MODE: '源码运行可检查版本；应用替换需从安装版启动。',
  UPDATE_BUSY: '正在处理更新，请稍后选择来源。',
  UPDATE_NOT_READY: '更新包尚未通过可安装检查，请重新准备。'
});
const HOOK_ERROR_CODES = Object.freeze({
  INVALID_SIGNATURE: 'SIGNATURE_INVALID', WRONG_BUNDLE: 'BUNDLE_ID_MISMATCH', WRONG_ARCH: 'ARCH_MISMATCH',
  CONFLICT: 'UPDATE_CHANGED', UNSAFE_PATH: 'INVALID_PACKAGE_PATH', INVALID_VERSION: 'VERSION_MISMATCH',
  NOT_NEWER: 'VERSION_MISMATCH'
});

class UpdateError extends Error {
  constructor(code, message) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'VERIFICATION_FAILED';
    super(typeof message === 'string' && message.length > 0 && message.length <= 512
      ? message.replace(/[\u0000-\u001f\u007f]/g, ' ')
      : MESSAGES[safeCode]);
    this.name = 'UpdateError';
    this.code = safeCode;
  }
}

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) throw new UpdateError('INVALID_MANIFEST');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) throw new UpdateError('INVALID_MANIFEST');
  const core = match.slice(1, 4).map(Number);
  if (core.some(number => !Number.isSafeInteger(number))) throw new UpdateError('INVALID_MANIFEST');
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) throw new UpdateError('INVALID_MANIFEST');
  return { core, pre };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined || b.pre[index] === undefined) return a.pre[index] === undefined ? -1 : 1;
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return x.length !== y.length ? Math.sign(x.length - y.length) : x > y ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validatePackagePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.includes('\\') || /[\u0000-\u001f\u007f:]/.test(value) || path.isAbsolute(value)
    || !value.toLowerCase().endsWith('.zip')
    || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new UpdateError('INVALID_PACKAGE_PATH');
  }
  return value;
}

function parseManifest(value, { platform, arch, bundleId }) {
  const keys = ['version', 'name', 'notes', 'pub_date', 'packagePath', 'sha256', 'size', 'platform', 'arch', 'bundleId'];
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new UpdateError('INVALID_MANIFEST');
  parseVersion(value.version);
  if (typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)
    || typeof value.platform !== 'string' || typeof value.arch !== 'string' || typeof value.bundleId !== 'string') {
    throw new UpdateError('INVALID_MANIFEST');
  }
  if (value.platform !== platform) throw new UpdateError('PLATFORM_MISMATCH');
  if (value.arch !== arch) throw new UpdateError('ARCH_MISMATCH');
  if (value.bundleId !== bundleId) throw new UpdateError('BUNDLE_ID_MISMATCH');
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200)) throw new UpdateError('INVALID_MANIFEST');
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 16384)) throw new UpdateError('INVALID_MANIFEST');
  if (value.pub_date !== undefined && (typeof value.pub_date !== 'string' || value.pub_date.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.pub_date)
    || !Number.isFinite(Date.parse(value.pub_date)))) throw new UpdateError('INVALID_MANIFEST');
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_PACKAGE_BYTES)) {
    throw new UpdateError('INVALID_MANIFEST');
  }
  return Object.freeze({
    version: value.version,
    name: value.name ?? value.version,
    notes: value.notes ?? '',
    ...(value.pub_date === undefined ? {} : { pub_date: value.pub_date }),
    packagePath: validatePackagePath(value.packagePath),
    sha256: value.sha256.toLowerCase(),
    ...(value.size === undefined ? {} : { size: value.size }),
    platform: value.platform,
    arch: value.arch,
    bundleId: value.bundleId
  });
}

function abortError(signal) {
  return signal.reason instanceof UpdateError ? signal.reason : new UpdateError('CANCELLED');
}

function assertNotAborted(signal) {
  if (signal.aborted) throw abortError(signal);
}

function withSignal(promise, signal) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function sameIdentity(a, b) { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino); }

async function assertSourceRoot(sourceRoot, sourceIdentity, signal) {
  assertNotAborted(signal);
  let stat;
  try { stat = await fsp.lstat(sourceRoot); }
  catch { throw new UpdateError('UPDATE_CHANGED'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, sourceIdentity)
    || await fsp.realpath(sourceRoot) !== sourceRoot) throw new UpdateError('UPDATE_CHANGED');
}

// The selected source is trusted only as a location. Every child component is
// checked without following symlinks; downloaded/cloud URLs are not supported.
async function resolveSourceFile(sourceRoot, relativeName, errorCode, signal, sourceIdentity, directoryPins) {
  await assertSourceRoot(sourceRoot, sourceIdentity, signal);
  let current = sourceRoot;
  const directories = new Map();
  for (const part of relativeName.split('/')) {
    assertNotAborted(signal);
    current = path.join(current, part);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch { throw new UpdateError(errorCode); }
    if (stat.isSymbolicLink()) throw new UpdateError('INVALID_PACKAGE_PATH');
    const final = current === path.join(sourceRoot, relativeName);
    if (final ? !stat.isFile() : !stat.isDirectory()) throw new UpdateError(errorCode);
    if (!final) {
      if (directoryPins && !sameIdentity(stat, directoryPins.get(current))) throw new UpdateError('UPDATE_CHANGED');
      directories.set(current, { dev: stat.dev, ino: stat.ino });
    }
  }
  const relative = path.relative(sourceRoot, current);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || await fsp.realpath(current) !== current) throw new UpdateError('INVALID_PACKAGE_PATH');
  return { filename: current, directories };
}

async function openReadOnly(file, errorCode) {
  try { return await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { throw new UpdateError(error?.code === 'ELOOP' ? 'INVALID_PACKAGE_PATH' : errorCode); }
}

async function readManifest(sourceRoot, signal, sourceIdentity) {
  const { filename: manifestPath } = await resolveSourceFile(sourceRoot, MANIFEST_NAME, 'READ_FAILED', signal, sourceIdentity);
  const file = await openReadOnly(manifestPath, 'READ_FAILED');
  try {
    await resolveSourceFile(sourceRoot, MANIFEST_NAME, 'READ_FAILED', signal, sourceIdentity);
    const before = await file.stat();
    if (!before.isFile()) throw new UpdateError('READ_FAILED');
    if (before.size > MAX_MANIFEST_BYTES) throw new UpdateError('MANIFEST_TOO_LARGE');
    const chunks = [];
    let total = 0;
    while (true) {
      assertNotAborted(signal);
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_MANIFEST_BYTES) throw new UpdateError('MANIFEST_TOO_LARGE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    await resolveSourceFile(sourceRoot, MANIFEST_NAME, 'READ_FAILED', signal, sourceIdentity);
    const pathStat = await fsp.lstat(manifestPath);
    if (!sameFile(before, after) || pathStat.isSymbolicLink() || !sameFile(after, pathStat)) throw new UpdateError('UPDATE_CHANGED');
    const bytes = Buffer.concat(chunks);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new UpdateError('INVALID_MANIFEST'); }
    return { parsed, digest: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}

async function hashPackage(sourceRoot, candidate, signal, sourceIdentity) {
  const { filename } = await resolveSourceFile(sourceRoot, candidate.manifest.packagePath, 'PACKAGE_NOT_FOUND', signal, sourceIdentity, candidate.directoryPins);
  const file = await openReadOnly(filename, 'PACKAGE_NOT_FOUND');
  try {
    await resolveSourceFile(sourceRoot, candidate.manifest.packagePath, 'PACKAGE_NOT_FOUND', signal, sourceIdentity, candidate.directoryPins);
    const before = await file.stat();
    if (!sameFile(candidate.packageStat, before)) throw new UpdateError('UPDATE_CHANGED');
    if (!before.isFile() || before.size <= 0 || before.size > MAX_PACKAGE_BYTES) throw new UpdateError('PACKAGE_TOO_LARGE');
    if (candidate.manifest.size !== undefined && before.size !== candidate.manifest.size) throw new UpdateError('CHECKSUM_MISMATCH');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(256 * 1024);
    let total = 0;
    while (true) {
      assertNotAborted(signal);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size || total > MAX_PACKAGE_BYTES) throw new UpdateError('UPDATE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== before.size) throw new UpdateError('UPDATE_CHANGED');
    const after = await file.stat();
    await resolveSourceFile(sourceRoot, candidate.manifest.packagePath, 'PACKAGE_NOT_FOUND', signal, sourceIdentity, candidate.directoryPins);
    const pathStat = await fsp.lstat(filename);
    if (!sameFile(before, after) || pathStat.isSymbolicLink() || !sameFile(after, pathStat)) throw new UpdateError('UPDATE_CHANGED');
    if (hash.digest('hex') !== candidate.manifest.sha256) throw new UpdateError('CHECKSUM_MISMATCH');
    return filename;
  } finally { await file.close(); }
}

function hookReasons(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).filter(reason => isRecord(reason) && typeof reason.code === 'string'
    && /^[A-Z0-9_]{1,64}$/.test(reason.code) && typeof reason.message === 'string' && reason.message.length <= 512)
    .map(reason => ({ code: reason.code, message: reason.message.replace(/[\u0000-\u001f\u007f]/g, ' ') }));
}

class UpdateService {
  #currentVersion; #platform; #arch; #bundleId; #verifyPackage; #installPackage; #onState;
  #timeoutMs; #stageTimeoutMs; #sourceRoot = ''; #sourceIdentity = null; #candidate = null; #staged = null;
  #state; #operation = null; #epoch = 0; #disposed = false;

  constructor({ currentVersion, platform = process.platform, arch = process.arch, bundleId,
    verifyPackage, installPackage, onState, timeoutMs = 15000, stageTimeoutMs = 120000 } = {}) {
    parseVersion(currentVersion);
    if (typeof bundleId !== 'string' || !/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(bundleId)) throw new UpdateError('BUNDLE_ID_MISMATCH');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) throw new UpdateError('INVALID_SOURCE');
    this.#currentVersion = currentVersion; this.#platform = platform; this.#arch = arch; this.#bundleId = bundleId;
    this.#verifyPackage = verifyPackage; this.#installPackage = installPackage; this.#onState = onState;
    this.#timeoutMs = timeoutMs; this.#stageTimeoutMs = stageTimeoutMs;
    this.#setState('unavailable', [{ code: 'SOURCE_NOT_CONFIGURED', message: MESSAGES.SOURCE_NOT_CONFIGURED }], false);
  }

  getStatus() {
    return structuredClone(this.#state);
  }

  #setState(status, reasons = [], notify = true) {
    const manifest = this.#candidate?.manifest;
    const busy = Boolean(this.#operation) || status === 'installing';
    this.#state = {
      currentVersion: this.#currentVersion, status, sourceRoot: this.#sourceRoot,
      ...(this.#sourceRoot ? { sourceManifest: path.join(this.#sourceRoot, MANIFEST_NAME) } : {}),
      ...(manifest ? { updateId: this.#candidate.updateId, availableVersion: manifest.version, releaseNotes: manifest.notes } : {}),
      ...(status === 'downloading' ? { progress: { indeterminate: true } } : {}),
      reasons: [...(this.#sourceRoot ? [INTEGRITY_REASON] : []), ...reasons],
      canCheck: Boolean(this.#sourceRoot) && !this.#disposed && !busy,
      canDownload: Boolean(manifest) && !this.#staged && typeof this.#verifyPackage === 'function' && !busy
        && (status === 'available' || status === 'error'),
      canInstall: Boolean(this.#staged?.verified && this.#staged?.canInstall) && typeof this.#installPackage === 'function'
        && !busy && (status === 'downloaded' || status === 'error'),
      verified: Boolean(this.#staged?.verified)
    };
    if (notify && typeof this.#onState === 'function') {
      try { this.#onState(this.getStatus()); } catch { /* UI notification failures cannot change update safety. */ }
    }
  }

  #assertOpen() {
    if (this.#disposed) throw new UpdateError('DISPOSED');
  }

  #begin(kind) {
    this.#assertOpen();
    if (this.#operation || this.#state.status === 'installing') throw new UpdateError('BUSY');
    const operation = { kind, epoch: this.#epoch, controller: new AbortController() };
    operation.timer = setTimeout(() => operation.controller.abort(new UpdateError('TIMEOUT')),
      kind === 'check' ? this.#timeoutMs : this.#stageTimeoutMs);
    this.#operation = operation;
    return operation;
  }

  #assertCurrent(operation) {
    if (this.#operation !== operation || this.#epoch !== operation.epoch) throw new UpdateError('CANCELLED');
    assertNotAborted(operation.controller.signal);
  }

  #finish(operation) {
    clearTimeout(operation.timer);
    if (this.#operation !== operation) return;
    this.#operation = null;
    const reasons = this.#state.reasons.filter(reason => reason.code !== 'LOCAL_CHECKSUM_ONLY');
    this.#setState(this.#state.status, reasons);
  }

  #cancel() {
    this.#epoch++;
    if (this.#operation) {
      clearTimeout(this.#operation.timer);
      this.#operation.controller.abort(new UpdateError('CANCELLED'));
      this.#operation = null;
    }
    this.#candidate = null;
    this.#staged = null;
  }

  #failure(error, fallbackCode, operation) {
    if (this.#operation !== operation || this.#epoch !== operation.epoch) return;
    const hookCode = HOOK_ERROR_CODES[error?.code] ?? (Object.hasOwn(MESSAGES, error?.code ?? '') ? error.code : fallbackCode);
    const safe = error instanceof UpdateError ? error : new UpdateError(hookCode);
    if (['UPDATE_CHANGED', 'CHECKSUM_MISMATCH', 'INVALID_PACKAGE_PATH', 'PACKAGE_NOT_FOUND'].includes(safe.code)) {
      this.#candidate = null; this.#staged = null;
    }
    this.#setState('error', [{ code: safe.code, message: safe.message }]);
  }

  // This method is main-only: its argument comes from the native directory picker,
  // never a renderer-selected arbitrary filesystem path or an environment secret.
  async configureLocalSource(directory) {
    this.#assertOpen();
    if (this.#state.status === 'installing') throw new UpdateError('BUSY');
    this.#cancel();
    this.#sourceRoot = '';
    this.#sourceIdentity = null;
    this.#setState('unavailable', [{ code: 'SOURCE_NOT_CONFIGURED', message: MESSAGES.SOURCE_NOT_CONFIGURED }]);
    const epoch = this.#epoch;
    try {
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f]/.test(directory)) throw new UpdateError('INVALID_SOURCE');
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UpdateError('INVALID_SOURCE');
      const real = await fsp.realpath(directory);
      const realStat = await fsp.lstat(real);
      if (!realStat.isDirectory() || realStat.isSymbolicLink() || !sameIdentity(stat, realStat)) throw new UpdateError('INVALID_SOURCE');
      if (epoch !== this.#epoch || this.#disposed) throw new UpdateError('CANCELLED');
      this.#sourceRoot = real;
      this.#sourceIdentity = { dev: realStat.dev, ino: realStat.ino };
      this.#setState('idle');
      return this.getStatus();
    } catch (error) {
      if (epoch === this.#epoch && !this.#disposed) {
        this.#setState('unavailable', [{ code: 'INVALID_SOURCE', message: MESSAGES.INVALID_SOURCE }]);
      }
      throw error instanceof UpdateError ? error : new UpdateError('INVALID_SOURCE');
    }
  }

  async check() {
    this.#assertOpen();
    if (!this.#sourceRoot) return this.getStatus();
    const operation = this.#begin('check');
    this.#candidate = null; this.#staged = null;
    this.#setState('checking');
    try {
      const sourceRoot = this.#sourceRoot;
      const data = await withSignal(readManifest(sourceRoot, operation.controller.signal, this.#sourceIdentity), operation.controller.signal);
      this.#assertCurrent(operation);
      const manifest = parseManifest(data.parsed, { platform: this.#platform, arch: this.#arch, bundleId: this.#bundleId });
      if (compareVersions(manifest.version, this.#currentVersion) <= 0) {
        this.#setState('up-to-date');
      } else {
        const { filename, directories } = await resolveSourceFile(sourceRoot, manifest.packagePath, 'PACKAGE_NOT_FOUND', operation.controller.signal, this.#sourceIdentity);
        const stat = await fsp.lstat(filename);
        this.#assertCurrent(operation);
        if (stat.size <= 0 || stat.size > MAX_PACKAGE_BYTES) throw new UpdateError('PACKAGE_TOO_LARGE');
        this.#candidate = { manifest, manifestDigest: data.digest, packageStat: stat, directoryPins: directories, updateId: crypto.randomUUID() };
        this.#setState('available', typeof this.#verifyPackage === 'function' ? []
          : [{ code: 'VERIFIER_NOT_CONFIGURED', message: MESSAGES.VERIFIER_NOT_CONFIGURED }]);
      }
    } catch (error) { this.#failure(error, 'READ_FAILED', operation); }
    finally { this.#finish(operation); }
    return this.getStatus();
  }

  #expectCandidate(options) {
    this.#assertOpen();
    if (!isRecord(options) || options.confirmed !== true) throw new UpdateError('CONFIRMATION_REQUIRED');
    if (!this.#candidate || typeof options.updateId !== 'string' || options.updateId !== this.#candidate.updateId) throw new UpdateError('STALE_UPDATE');
  }

  #hookInput(packagePath, operation) {
    const manifest = this.#candidate.manifest;
    return {
      packagePath,
      updateId: this.#candidate.updateId,
      expected: Object.freeze({ version: manifest.version, currentVersion: this.#currentVersion, sha256: manifest.sha256,
        platform: manifest.platform, arch: manifest.arch, bundleId: manifest.bundleId }),
      signal: operation.controller.signal
    };
  }

  async downloadAndStage(options) {
    this.#expectCandidate(options);
    if (this.#staged) return this.getStatus();
    if (typeof this.#verifyPackage !== 'function') throw new UpdateError('VERIFIER_NOT_CONFIGURED');
    const operation = this.#begin('stage');
    this.#setState('downloading');
    try {
      const sourceRoot = this.#sourceRoot;
      const data = await withSignal(readManifest(sourceRoot, operation.controller.signal, this.#sourceIdentity), operation.controller.signal);
      this.#assertCurrent(operation);
      if (data.digest !== this.#candidate.manifestDigest) throw new UpdateError('UPDATE_CHANGED');
      const packagePath = await withSignal(hashPackage(sourceRoot, this.#candidate, operation.controller.signal, this.#sourceIdentity), operation.controller.signal);
      this.#assertCurrent(operation);
      const result = await withSignal(this.#verifyPackage(this.#hookInput(packagePath, operation)), operation.controller.signal);
      this.#assertCurrent(operation);
      if (!isRecord(result) || result.verified !== true || typeof result.canInstall !== 'boolean') throw new UpdateError('VERIFICATION_FAILED');
      const reasons = hookReasons(result.reasons);
      if (!result.canInstall && !reasons.length) reasons.push({ code: 'INSTALL_BLOCKED', message: MESSAGES.INSTALL_BLOCKED });
      if (typeof this.#installPackage !== 'function') reasons.push({ code: 'INSTALLER_NOT_CONFIGURED', message: MESSAGES.INSTALLER_NOT_CONFIGURED });
      this.#staged = { packagePath, verified: true, canInstall: result.canInstall, reasons };
      this.#setState('downloaded', reasons);
    } catch (error) { this.#failure(error, 'VERIFICATION_FAILED', operation); }
    finally { this.#finish(operation); }
    return this.getStatus();
  }

  // The installer rechecks its private staged ZIP/application before atomic
  // replacement and owns rollback/restart. This service never writes an app,
  // changes quarantine/security settings, or installs merely because it exits.
  async restartAndInstall(options) {
    this.#expectCandidate(options);
    if (!this.#staged?.verified) throw new UpdateError('UPDATE_NOT_READY');
    if (!this.#staged.canInstall) throw new UpdateError('INSTALL_BLOCKED');
    if (typeof this.#installPackage !== 'function') throw new UpdateError('INSTALLER_NOT_CONFIGURED');
    const operation = this.#begin('install');
    this.#setState('installing', this.#staged.reasons);
    try {
      await withSignal(this.#installPackage(this.#hookInput(this.#staged.packagePath, operation)), operation.controller.signal);
      this.#assertCurrent(operation);
      // Success here confirms only dispatch to the independently verified helper.
      // The helper is responsible for the outcome; no "updated" claim is made.
    } catch (error) { this.#failure(error, 'INSTALL_FAILED', operation); }
    finally { this.#finish(operation); }
    return this.getStatus();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel();
    this.#sourceRoot = '';
    this.#sourceIdentity = null;
    this.#setState('unavailable', [{ code: 'DISPOSED', message: MESSAGES.DISPOSED }]);
  }
}

module.exports = { UpdateService, UpdateError, compareVersions, parseManifest };
