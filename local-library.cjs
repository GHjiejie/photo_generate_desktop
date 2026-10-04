const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MAX_IMAGE = 30 * 1024 * 1024;
const MAX_INDEX = 32 * 1024 * 1024;
const IMAGE_REL = /^assets\/images\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.(png|jpe?g|webp)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PHOTO_IDS = new Set([1, 3, 12, 13, 31, 32, 33, 91]);
const META = '.portrait-studio';
const INDEX = `${META}/library.json`;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

class LibraryError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LibraryError';
    this.code = code;
  }
}

function fail(code, message) { throw new LibraryError(code, message); }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function encode(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function idValid(id) { return Number.isSafeInteger(id) && id >= 1 && id <= 999999; }
function revisionValid(value) { return Number.isSafeInteger(value) && value >= 1; }
function metadata(value) {
  if (!isObject(value) || !idValid(value.id)) fail('INVALID_DATA', '编号必须是 1 至 999999 的整数。');
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 160 || /[\u0000-\u001f\u007f]/.test(value.label)) {
    fail('INVALID_DATA', '名称不能为空，且最多 160 个字符。');
  }
  if (!['photo', 'art'].includes(value.type)) fail('INVALID_DATA', '请选择摄影质感或绘画质感。');
  if (!isObject(value.prompts) || ['en', 'zh'].some(language => typeof value.prompts[language] !== 'string' || !value.prompts[language].trim() || value.prompts[language].length > 65536 || value.prompts[language].includes('\0'))) {
    fail('INVALID_DATA', '英文与中文提示词都不能为空，且各自最多 65536 个字符。');
  }
  return { id: value.id, label: value.label, type: value.type, prompts: { en: value.prompts.en, zh: value.prompts.zh } };
}
function validateTranslationProvenance(provenance, { sourceMetadata, sourceId, recordIndex, manifestSha256, derivedChinesePrompt }) {
  const keys = ['kind', 'origin', 'sourceLanguage', 'targetLanguage', 'sourcePromptField', 'sourcePromptSha256', 'translatedPromptSha256', 'sourceId', 'recordIndex', 'manifestSha256'];
  const originalId = typeof sourceMetadata?.id === 'string' && /^\d{1,6}$/.test(sourceMetadata.id) ? Number(sourceMetadata.id) : sourceMetadata?.id;
  const originalPrompt = field => field === 'prompts.en' ? sourceMetadata?.prompts?.en : sourceMetadata?.[field];
  const sourcePromptField = ['prompt_en', 'prompt', 'prompts.en'].find(field => originalPrompt(field) !== undefined);
  const english = originalPrompt(sourcePromptField);
  if (!isObject(provenance) || Object.keys(provenance).length !== keys.length || keys.some(key => !Object.hasOwn(provenance, key))
    || provenance.kind !== 'derived-translation' || provenance.origin !== 'assistant-translation' || provenance.sourceLanguage !== 'en' || provenance.targetLanguage !== 'zh'
    || !idValid(sourceId) || originalId !== sourceId || provenance.sourceId !== sourceId || provenance.recordIndex !== recordIndex || provenance.manifestSha256 !== manifestSha256
    || !HASH.test(provenance.sourcePromptSha256 || '') || !HASH.test(provenance.translatedPromptSha256 || '') || !HASH.test(manifestSha256 || '')
    || provenance.sourcePromptField !== sourcePromptField || typeof english !== 'string' || !english.trim() || english.length > 65536 || english.includes('\0')
    || typeof derivedChinesePrompt !== 'string' || !derivedChinesePrompt.trim() || derivedChinesePrompt.length > 65536 || derivedChinesePrompt.includes('\0')
    || ['prompt_cn', 'prompt_zh'].some(field => Object.hasOwn(sourceMetadata, field)) || isObject(sourceMetadata.prompts) && Object.hasOwn(sourceMetadata.prompts, 'zh')
    || sha(Buffer.from(english, 'utf8')) !== provenance.sourcePromptSha256 || sha(Buffer.from(derivedChinesePrompt, 'utf8')) !== provenance.translatedPromptSha256) {
    fail('INVALID_DATA', '中文衍生译文与原始提示词的来源记录或校验信息无效。');
  }
}
function validateIndex(value) {
  if (!isObject(value) || value.schemaVersion !== 1 || !revisionValid(value.revision) || !Array.isArray(value.items) || value.items.length > 10000) {
    fail('INVALID_DATA', '素材索引格式无效，请保留文件并检查索引。');
  }
  const ids = new Set();
  const images = new Set();
  for (const item of value.items) {
    metadata(item);
    if (ids.has(item.id) || images.has(item.imageRel)) fail('INVALID_DATA', '素材索引含重复编号或图片。');
    ids.add(item.id); images.add(item.imageRel);
    if (!revisionValid(item.revision) || typeof item.imageRel !== 'string' || !IMAGE_REL.test(item.imageRel) || item.image !== path.posix.basename(item.imageRel) || !HASH.test(item.sha256 || '') || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_IMAGE || typeof item.mime !== 'string' || !Object.hasOwn(mimeExtensions, item.mime)) {
      fail('INVALID_DATA', '素材索引中的图片路径或校验信息无效。');
    }
    if (mimeExtensions[item.mime] === 'png' && !/\.png$/i.test(item.image) || item.mime === 'image/jpeg' && !/\.jpe?g$/i.test(item.image) || item.mime === 'image/webp' && !/\.webp$/i.test(item.image)) {
      fail('INVALID_DATA', '素材图片格式与索引不一致。');
    }
    if (Object.hasOwn(item, 'sourceMetadata') || Object.hasOwn(item, 'sourceImport')) {
      const source = item.sourceImport;
      if (!isObject(item.sourceMetadata) || !isObject(source) || !new RegExp(`^${META.replace('.', '\\.')}\\/imports\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(source.archiveRel || '') || !HASH.test(source.manifestSha256 || '') || !HASH.test(source.sourceHash || '') || !Number.isSafeInteger(source.recordIndex) || source.recordIndex < 0 || source.recordIndex >= 500 || typeof source.sourceFileName !== 'string' || path.basename(source.sourceFileName) !== source.sourceFileName || !['source', 'selected-default'].includes(source.typeOrigin)) fail('INVALID_DATA', '批次素材来源信息无效，请保留索引检查。');
      if (Object.hasOwn(source, 'sourceRelativePath') && (typeof source.sourceRelativePath !== 'string' || source.sourceRelativePath.length > 4096 || path.isAbsolute(source.sourceRelativePath) || /[\u0000-\u001f\u007f\\]/.test(source.sourceRelativePath) || source.sourceRelativePath.split('/').some(part => !part || part === '.' || part === '..' || part.length > 255) || path.basename(source.sourceRelativePath) !== source.sourceFileName)) fail('INVALID_DATA', '批次图片相对路径无效，请保留索引检查。');
      if (Object.hasOwn(source, 'sourceId')) {
        const originalId = typeof item.sourceMetadata.id === 'string' && /^\d{1,6}$/.test(item.sourceMetadata.id) ? Number(item.sourceMetadata.id) : item.sourceMetadata.id;
        if (!idValid(source.sourceId) || originalId !== source.sourceId) fail('INVALID_DATA', '批次来源编号与原始记录不一致。');
      }
      if (Object.hasOwn(source, 'translationProvenance') || Object.hasOwn(source, 'derivedChinesePrompt')) validateTranslationProvenance(source.translationProvenance, { ...source, sourceMetadata: item.sourceMetadata });
    }
  }
  return value;
}
function imageMime(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (width && height && width <= 50000 && height <= 50000 && width * height <= 100000000) return 'image/png';
  }
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16)) && buffer.readUInt32LE(4) + 8 <= buffer.length) return 'image/webp';
  fail('INVALID_IMAGE', '图片格式无效，请选择有效的 PNG、JPEG 或 WebP 图片。');
}
function translateError(error) {
  if (error instanceof LibraryError || error?.crash) return error;
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return new LibraryError('NO_PERMISSION', '素材目录没有写入权限，请选择可写的本地仓库目录。', error);
  if (error?.code === 'ENOSPC') return new LibraryError('IO_ERROR', '磁盘空间不足，操作已停止，请检查素材目录。', error);
  return new LibraryError('IO_ERROR', '本地文件操作失败，已尝试恢复原素材；请重试或检查目录。', error);
}

const batches = require('./library-batch-transaction.cjs')({ fs, constants, path, crypto, LibraryError, fail, sha, encode, clone, isObject, metadata, validateIndex, validateTranslationProvenance, imageMime, MAX_IMAGE, MAX_INDEX, INDEX, META, UUID, HASH, NOFOLLOW, mimeExtensions });

class LocalLibrary {
  constructor({ trashItem, validateImage, fault } = {}) {
    this.trashItem = trashItem;
    this.validateImage = validateImage;
    this.fault = fault;
    this.root = null;
    this.rootIdentity = null;
    this.directoryIdentities = new Map();
    this.fileIdentities = new Map();
    this.indexHash = null;
    this.queue = Promise.resolve();
  }

  _enqueue(task) {
    const result = this.queue.then(task).catch(error => { throw translateError(error); });
    this.queue = result.catch(() => {});
    return result;
  }

  async _root(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) fail('INVALID_ROOT', '请选择一个完整的本地素材目录。');
    const requested = path.resolve(root);
    const stat = await fs.lstat(requested).catch(error => { if (error.code === 'ENOENT') fail('INVALID_ROOT', '所选素材目录不存在。'); throw error; });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', '素材目录必须是真实目录，不能是符号链接。');
    const real = await fs.realpath(requested);
    const forbidden = ['/', '/Users', '/Volumes', '/private', '/tmp', '/private/tmp', '/var', '/private/var', os.homedir()];
    if (forbidden.includes(real) || /(?:^|\/)[^/]+\.(?:app|asar|asar\.unpacked)(?:\/|$)/i.test(real) || ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/dev', '/proc'].some(parent => real === parent || real.startsWith(`${parent}/`))) {
      fail('INVALID_ROOT', '请选择项目素材目录；系统目录、应用包和 ASAR 目录不能作为素材仓库。');
    }
    await fs.access(real, constants.R_OK | constants.W_OK | constants.X_OK);
    return real;
  }

  async _safe(relative, type, optional = false) {
    if (!this.root || typeof relative !== 'string' || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\') || relative.includes('\0')) fail('UNSAFE_PATH', '素材路径越出了已授权目录。');
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(this.root) !== this.root || this.rootIdentity && (rootStat.dev !== this.rootIdentity.dev || rootStat.ino !== this.rootIdentity.ino)) fail('UNSAFE_PATH', '素材根目录已被替换，请重新选择目录。');
    let current = this.root;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (error.code === 'ENOENT' && optional && i === parts.length - 1) return current;
        if (error.code === 'ENOENT') fail('NOT_FOUND', '素材文件或目录不存在。');
        throw error;
      }
      if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH', '素材路径包含符号链接或非法目录。');
      if (stat.isDirectory()) {
        const key = parts.slice(0, i + 1).join('/');
        const identity = this.directoryIdentities.get(key);
        if (identity && (identity.dev !== stat.dev || identity.ino !== stat.ino)) fail('UNSAFE_PATH', '素材管理目录已被其他程序替换，请重新选择目录。');
        this.directoryIdentities.set(key, { dev: stat.dev, ino: stat.ino });
      }
      if (i === parts.length - 1 && (type === 'file' && !stat.isFile() || type === 'directory' && !stat.isDirectory())) fail('UNSAFE_PATH', '素材路径的文件类型不正确。');
    }
    if (await fs.realpath(current) !== current) fail('UNSAFE_PATH', '素材路径越出了已授权目录。');
    return current;
  }

  async _mkdir(relative) {
    const parent = path.posix.dirname(relative);
    if (parent !== '.') await this._safe(parent, 'directory');
    const target = await this._safe(relative, 'directory', true);
    try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await this._safe(relative, 'directory');
    await this._syncDirectory(parent);
  }

  async _layout() {
    for (const directory of ['assets', 'assets/images', META, `${META}/transactions`, `${META}/recovery`]) await this._mkdir(directory);
  }

  async _syncDirectory(relative) {
    const directory = relative === '.' ? this.root : await this._safe(relative, 'directory');
    const handle = await fs.open(directory, constants.O_RDONLY | NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async _writeExclusive(relative, bytes) {
    const target = await this._safe(relative, 'file', true);
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    const owned = await handle.stat();
    let failed;
    try { await handle.writeFile(bytes); await handle.sync(); await this._syncDirectory(path.posix.dirname(relative)); } catch (error) { failed = error; } finally { await handle.close(); }
    if (failed) {
      // Remove only the partial file this call created, never an external replacement.
      const current = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(await this._safe(relative, 'file'));
      this.fileIdentities.delete(relative);
      throw failed;
    }
    this.fileIdentities.delete(relative);
    return { dev: owned.dev, ino: owned.ino };
  }

  async _read(relative, limit = MAX_INDEX) {
    const target = await this._safe(relative, 'file');
    const handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW);
    try {
      const before = await handle.stat();
      const identity = this.fileIdentities.get(relative);
      if (identity && (identity.dev !== before.dev || identity.ino !== before.ino)) fail('CONFLICT', '素材管理文件被其他程序替换，请重新载入目录。');
      if (!before.isFile() || before.size > limit) fail('INVALID_DATA', '本地文件大小超过允许范围。');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('CONFLICT', '文件被其他程序修改，请重新载入素材目录。');
      this.fileIdentities.set(relative, { dev: before.dev, ino: before.ino });
      return bytes;
    } finally { await handle.close(); }
  }

  async _atomic(relative, bytes, expectedHash) {
    const target = await this._safe(relative, 'file', true);
    const temporary = `${path.posix.dirname(relative)}/.${path.posix.basename(relative)}-${crypto.randomUUID()}.tmp`;
    try {
      await this._writeExclusive(temporary, bytes);
      await this._safe(relative, 'file', true);
      if (expectedHash !== undefined) {
        const actual = await this._read(relative).then(sha).catch(error => { if (error.code === 'NOT_FOUND') return null; throw error; });
        if (actual !== expectedHash) fail('CONFLICT', '素材索引已被其他程序修改，本次操作没有覆盖它。');
      }
      await fs.rename(await this._safe(temporary, 'file'), target);
      this.fileIdentities.delete(temporary);
      this.fileIdentities.delete(relative);
      await this._syncDirectory(path.posix.dirname(relative));
    } finally {
      await fs.unlink(await this._safe(temporary, 'file', true)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.fileIdentities.delete(temporary);
    }
  }

  async _acquireLock() {
    const relative = `${META}/lock.json`;
    const token = crypto.randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this._writeExclusive(relative, encode({ pid: process.pid, token, createdAt: new Date().toISOString() }));
        return async () => {
          const bytes = await this._read(relative, 4096);
          const lock = JSON.parse(bytes.toString('utf8'));
          if (lock.token === token) { await fs.unlink(await this._safe(relative, 'file')); this.fileIdentities.delete(relative); await this._syncDirectory(META); }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let bytes, lock;
        try { bytes = await this._read(relative, 4096); lock = JSON.parse(bytes.toString('utf8')); } catch { fail('LIBRARY_BUSY', '素材目录正在使用，或锁文件无效；请关闭其他实例后重试。'); }
        if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || typeof lock.token !== 'string') fail('LIBRARY_BUSY', '素材目录锁文件无效，请检查其他实例。');
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
        if (alive) fail('LIBRARY_BUSY', '另一个应用实例正在操作此素材目录，请稍后重试。');
        // A separate exclusive reclaim marker serializes stale-lock removal.
        const marker = `${META}/lock-reclaim.json`;
        try { await this._writeExclusive(marker, encode({ pid: process.pid, token })); } catch (claim) {
          if (claim.code === 'EEXIST') {
            let claimant;
            const claimedBytes = await this._read(marker, 4096);
            try { claimant = JSON.parse(claimedBytes.toString('utf8')); } catch { fail('LIBRARY_BUSY', '素材目录正在恢复锁，请稍后重试。'); }
            if (!Number.isSafeInteger(claimant.pid) || claimant.pid < 1 || !UUID.test(claimant.token || '')) fail('LIBRARY_BUSY', '素材目录恢复锁格式无效，文件已保留。');
            let claimantAlive = true;
            try { process.kill(claimant.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') claimantAlive = false; }
            if (claimantAlive) fail('LIBRARY_BUSY', '素材目录正在恢复锁，请稍后重试。');
            if (sha(await this._read(marker, 4096)) === sha(claimedBytes)) { await fs.unlink(await this._safe(marker, 'file')); this.fileIdentities.delete(marker); await this._syncDirectory(META); }
            continue;
          }
          throw claim;
        }
        try {
          if (sha(await this._read(relative, 4096)) === sha(bytes)) { await fs.unlink(await this._safe(relative, 'file')); this.fileIdentities.delete(relative); }
        } finally { await fs.unlink(await this._safe(marker, 'file')); this.fileIdentities.delete(marker); }
      }
    }
    fail('LIBRARY_BUSY', '素材目录正被其他实例使用，请稍后重试。');
  }

  async _locked(task) {
    if (!this.root) fail('NOT_CONFIGURED', '请先选择本地素材目录。');
    await this._safe(META, 'directory');
    const release = await this._acquireLock();
    try { await this._recover(); await batches.recover(this); return await task(); } finally { await release(); }
  }

  async _image(item) {
    const bytes = await this._read(item.imageRel, MAX_IMAGE);
    if (bytes.length !== item.size || sha(bytes) !== item.sha256 || imageMime(bytes) !== item.mime) fail('CONFLICT', '素材图片被外部修改，请保留文件并重新载入目录。');
    return bytes;
  }

  async _load(fresh = false) {
    const bytes = await this._read(INDEX);
    const hash = sha(bytes);
    if (!fresh && this.indexHash && hash !== this.indexHash) fail('CONFLICT', '素材索引已被其他实例修改，请重新载入目录后操作。');
    let index;
    try { index = validateIndex(JSON.parse(bytes.toString('utf8'))); } catch (error) { if (error instanceof LibraryError) throw error; fail('INVALID_DATA', '素材索引不是有效 JSON，请保留文件并检查。'); }
    for (const item of index.items) await this._image(item);
    this.indexHash = hash;
    return { index, raw: bytes.toString('utf8'), hash };
  }

  _public(index) {
    return { configured: true, root: this.root, writable: true, revision: index.revision, items: index.items.map(item => ({ id: item.id, label: item.label, type: item.type, prompts: clone(item.prompts), image: item.image, imageRel: item.imageRel, revision: item.revision, image_url: `portrait-media://asset/${item.id}?revision=${item.revision}`, ...(item.sourceMetadata ? { sourceMetadata: clone(item.sourceMetadata), sourceImport: clone(item.sourceImport) } : {}) })) };
  }

  async _seed() {
    let originals;
    try { originals = await this._read('assets/selected-prompts.json'); } catch (error) {
      if (error.code !== 'NOT_FOUND') throw error;
      return { schemaVersion: 1, revision: 1, items: [], updatedAt: new Date().toISOString() };
    }
    let selected, chinese;
    try {
      selected = JSON.parse(originals.toString('utf8'));
      chinese = JSON.parse((await this._read('assets/prompts.zh.json')).toString('utf8'));
    } catch (error) { if (error.code === 'UNSAFE_PATH') throw error; fail('INVALID_DATA', '原始英文和中文提示词文件缺失或格式无效。'); }
    if (!Array.isArray(selected) || !isObject(chinese)) fail('INVALID_DATA', '原始提示词数据格式无效。');
    const items = [];
    for (const original of selected) {
      if (!isObject(original)) fail('INVALID_DATA', '原始素材记录格式无效。');
      const info = metadata({ id: original.id, label: original.label, type: PHOTO_IDS.has(original.id) ? 'photo' : 'art', prompts: { en: original.prompt, zh: chinese[String(original.id)] } });
      const imageRel = `assets/images/${original.image}`;
      if (!IMAGE_REL.test(imageRel)) fail('UNSAFE_PATH', '原始素材图片路径无效。');
      const bytes = await this._read(imageRel, MAX_IMAGE);
      const mime = imageMime(bytes);
      if (this.validateImage && await this.validateImage(bytes, { mime, size: bytes.length, path: await this._safe(imageRel, 'file') }) === false) fail('INVALID_IMAGE', '原始素材图片无法解码。');
      items.push({ ...info, image: original.image, imageRel, revision: 1, size: bytes.length, sha256: sha(bytes), mime });
    }
    return validateIndex({ schemaVersion: 1, revision: 1, items, updatedAt: new Date().toISOString() });
  }

  open(root) {
    return this._enqueue(async () => {
      const previous = { root: this.root, rootIdentity: this.rootIdentity, directoryIdentities: this.directoryIdentities, fileIdentities: this.fileIdentities, indexHash: this.indexHash };
      this.root = await this._root(root); this.indexHash = null;
      const rootStat = await fs.lstat(this.root);
      this.rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
      this.directoryIdentities = new Map(); this.fileIdentities = new Map();
      try {
        await this._layout();
        return await this._locked(async () => {
          try { await this._safe(INDEX, 'file'); } catch (error) {
            if (error.code !== 'NOT_FOUND') throw error;
            const seeded = encode(await this._seed());
            if (Buffer.byteLength(seeded) > MAX_INDEX) fail('INVALID_DATA', '素材索引超过 32 MiB，请减少条目或提示词长度。');
            await this._atomic(INDEX, seeded, null);
          }
          return this._public((await this._load(true)).index);
        });
      } catch (error) { Object.assign(this, previous); throw error; }
    });
  }

  list({ refresh = false } = {}) {
    return this._enqueue(() => !this.root ? { configured: false, root: null, writable: false, revision: 0, items: [] } : this._locked(async () => {
      if (refresh === true) this.fileIdentities.delete(INDEX);
      return this._public((await this._load(refresh === true)).index);
    }));
  }

  get(id) {
    return this._enqueue(() => this._locked(async () => {
      if (!idValid(id)) fail('INVALID_DATA', '素材编号无效。');
      const { index } = await this._load();
      const item = this._public(index).items.find(candidate => candidate.id === id);
      if (!item) fail('NOT_FOUND', '这张素材已不存在，请刷新列表。');
      return { revision: index.revision, item };
    }));
  }

  imageForId(id) {
    return this._enqueue(() => this._locked(async () => {
      if (!idValid(id)) fail('INVALID_DATA', '素材编号无效。');
      const { index } = await this._load();
      const item = index.items.find(candidate => candidate.id === id);
      if (!item) fail('NOT_FOUND', '这张素材已不存在，请刷新列表。');
      const imagePath = await this._safe(item.imageRel, 'file');
      const stat = await fs.lstat(imagePath);
      return { path: imagePath, mime: item.mime, dev: stat.dev, ino: stat.ino, size: item.size, sha256: item.sha256 };
    }));
  }

  _compare(index, payload, item) {
    if (!isObject(payload) || !revisionValid(payload.expectedVersion) || payload.expectedVersion !== index.revision || item && (!revisionValid(payload.expectedRevision) || payload.expectedRevision !== item.revision)) fail('CONFLICT', '素材已发生变化，请刷新后再编辑或删除。');
  }

  async _import(imageSource) {
    const authorization = typeof imageSource === 'string' ? null : imageSource;
    const imagePath = authorization?.path || imageSource;
    if (authorization && (!isObject(authorization) || Object.keys(authorization).some(key => !['path', 'sha256', 'expectedSha256', 'dev', 'ino', 'size'].includes(key)) || !HASH.test(authorization.sha256 || authorization.expectedSha256 || '') || !Number.isSafeInteger(authorization.dev) || !Number.isSafeInteger(authorization.ino) || authorization.size !== undefined && (!Number.isSafeInteger(authorization.size) || authorization.size < 1 || authorization.size > MAX_IMAGE))) fail('INVALID_IMAGE', '所选图片授权无效，请重新选择图片。');
    if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath) || imagePath.includes('\0') || !/\.(png|jpe?g|webp)$/i.test(imagePath)) fail('INVALID_IMAGE', '请选择本地 PNG、JPEG 或 WebP 图片。');
    const stat = await fs.lstat(imagePath).catch(error => { if (error.code === 'ENOENT') fail('INVALID_IMAGE', '所选图片已不存在。'); throw error; });
    if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', '导入图片必须是真实文件，不能是符号链接。');
    const real = await fs.realpath(imagePath);
    const handle = await fs.open(real, constants.O_RDONLY | NOFOLLOW);
    let bytes;
    try {
      const before = await handle.stat();
      if (authorization && (before.dev !== authorization.dev || before.ino !== authorization.ino || authorization.size !== undefined && before.size !== authorization.size)) fail('CONFLICT', '所选图片被替换，请重新选择图片。');
      if (!before.size || before.size > MAX_IMAGE) fail('INVALID_IMAGE', '图片不能为空，且不能超过 30 MiB。');
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('CONFLICT', '导入图片被修改，请重新选择图片。');
    } finally { await handle.close(); }
    const mime = imageMime(bytes);
    if (authorization && sha(bytes) !== (authorization.sha256 || authorization.expectedSha256)) fail('CONFLICT', '所选图片内容已变化，请重新选择图片。');
    if (this.validateImage && await this.validateImage(bytes, { mime, size: bytes.length, path: real }) === false) fail('INVALID_IMAGE', '图片无法解码，请选择有效图片。');
    return { bytes, mime, size: bytes.length, sha256: sha(bytes) };
  }

  create(payload, imagePath) { return this._enqueue(() => this._locked(() => this._mutate('create', payload, imagePath))); }
  update(payload, imagePath) { return this._enqueue(() => this._locked(() => this._mutate('update', payload, imagePath))); }
  remove(payload) { return this._enqueue(() => this._locked(() => this._mutate('remove', payload))); }
  previewBatch(plan, options) { return this._enqueue(() => this._locked(() => batches.preview(this, plan, options))); }
  importBatch(plan, options) { return this._enqueue(() => this._locked(() => batches.import(this, plan, options))); }

  async _fault(phase, journal) { if (this.fault) await this.fault(phase, { txId: journal.txId, operation: journal.operation, root: this.root }); }

  async _journal(journal) {
    const bytes = encode(journal);
    if (Buffer.byteLength(bytes) > MAX_INDEX * 4) fail('INVALID_DATA', '事务恢复记录过大，本次操作已停止。');
    await this._atomic(`${META}/transactions/${journal.txId}/journal.json`, bytes);
  }

  async _record(journal, status) {
    if (!journal.oldItem) return;
    await this._atomic(`${META}/recovery/${journal.txId}/record.json`, encode({ schemaVersion: 1, txId: journal.txId, operation: journal.operation, status, recordedAt: journal.createdAt, item: journal.oldItem, imageBackupRel: journal.backupRel, beforeVersion: journal.before.revision, afterVersion: journal.after.revision }));
  }

  async _mutate(operation, payload, imagePath) {
    const allowedKeys = operation === 'remove' ? ['id', 'expectedVersion', 'expectedRevision', 'confirmed'] : ['id', 'label', 'type', 'prompts', 'expectedVersion', ...(operation === 'update' ? ['expectedRevision'] : [])];
    if (!isObject(payload) || Object.keys(payload).some(key => !allowedKeys.includes(key)) || operation !== 'remove' && isObject(payload.prompts) && Object.keys(payload.prompts).some(key => !['en', 'zh'].includes(key))) fail('INVALID_DATA', '请求包含不支持的字段或文件路径。');
    const loaded = await this._load();
    const before = loaded.index;
    if (!isObject(payload) || !idValid(payload.id)) fail('INVALID_DATA', '素材编号无效。');
    const oldItem = before.items.find(item => item.id === payload.id) || null;
    this._compare(before, payload, operation === 'create' ? null : oldItem);
    if (operation === 'create' && oldItem) fail('DUPLICATE_ID', '这个编号已被使用，请换一个编号。');
    if (operation !== 'create' && !oldItem) fail('NOT_FOUND', '这张素材已不存在，请刷新列表。');
    if (operation === 'remove' && payload.confirmed !== true) fail('CONFIRMATION_REQUIRED', '请确认后再将素材移到系统废纸篓。');
    const info = operation === 'remove' ? null : metadata(payload);
    const imported = operation === 'create' || imagePath !== undefined && imagePath !== null ? await this._import(imagePath) : null;
    if ((operation === 'remove' || imported && oldItem) && typeof this.trashItem !== 'function') fail('IO_ERROR', '系统废纸篓服务不可用，素材没有被删除。');
    const txId = crypto.randomUUID();
    const txRel = `${META}/transactions/${txId}`;
    const createdAt = new Date().toISOString();
    const newImage = imported ? { image: `${String(payload.id).padStart(6, '0')}-${txId}.${mimeExtensions[imported.mime]}`, mime: imported.mime, size: imported.size, sha256: imported.sha256 } : oldItem;
    const newItem = info ? { ...(oldItem?.sourceMetadata ? { sourceMetadata: clone(oldItem.sourceMetadata), sourceImport: clone(oldItem.sourceImport) } : {}), ...info, image: newImage.image, imageRel: `assets/images/${newImage.image}`, mime: newImage.mime, size: newImage.size, sha256: newImage.sha256, revision: oldItem ? oldItem.revision + 1 : 1 } : null;
    const after = { ...clone(before), revision: before.revision + 1, updatedAt: createdAt, items: before.items.filter(item => item.id !== payload.id).concat(newItem ? [newItem] : []).sort((a, b) => a.id - b.id) };
    validateIndex(after);
    const afterRaw = encode(after);
    if (Buffer.byteLength(afterRaw) > MAX_INDEX) fail('INVALID_DATA', '素材索引超过 32 MiB，请减少条目或提示词长度。');
    const journal = { schemaVersion: 1, txId, operation, root: this.root, createdAt, phase: 'prepared', before, beforeRaw: loaded.raw, after, afterRaw, oldItem, newItem, installedImageRel: imported ? newItem.imageRel : null, stageRel: imported ? `${txRel}/image.${mimeExtensions[imported.mime]}` : null, installedIdentity: null, backupRel: oldItem ? `${META}/recovery/${txId}/image.${mimeExtensions[oldItem.mime]}` : null };
    if (Buffer.byteLength(encode(journal)) > MAX_INDEX * 4 - 1024) fail('INVALID_DATA', '事务恢复记录过大，本次操作已停止。');
    let prepared = false;
    try {
      await this._mkdir(txRel);
      if (oldItem) {
        await this._mkdir(`${META}/recovery/${txId}`);
        await this._writeExclusive(journal.backupRel, await this._image(oldItem));
      }
      if (imported) {
        await this._writeExclusive(journal.stageRel, imported.bytes);
        const staged = await fs.lstat(await this._safe(journal.stageRel, 'file'));
        journal.installedIdentity = { dev: staged.dev, ino: staged.ino };
      }
      await this._journal(journal);
      prepared = true;
      await this._record(journal, 'pending');
      if (imported) {
        const stagedBytes = await this._read(journal.stageRel, MAX_IMAGE);
        if (sha(stagedBytes) !== newItem.sha256 || stagedBytes.length !== newItem.size) fail('CONFLICT', '导入副本被其他程序修改，本次操作已停止。');
        const stagedPath = await this._safe(journal.stageRel, 'file');
        const staged = await fs.lstat(stagedPath);
        if (staged.dev !== journal.installedIdentity.dev || staged.ino !== journal.installedIdentity.ino) fail('CONFLICT', '导入副本被替换，本次操作已停止。');
        // The fully written staged inode is linked atomically without overwriting.
        // This avoids partially written live images if the process crashes.
        await fs.link(stagedPath, await this._safe(journal.installedImageRel, 'file', true));
        this.fileIdentities.delete(journal.installedImageRel);
        await this._syncDirectory('assets/images');
        journal.phase = 'image-installed'; await this._journal(journal);
        await this._fault('after-image-install', journal);
      }
      if (operation === 'remove' || imported && oldItem) {
        journal.phase = 'trashing'; await this._journal(journal);
        // Recheck immediately before passing the authorized original to native Trash.
        await this._image(oldItem);
        await this.trashItem(await this._safe(oldItem.imageRel, 'file'));
        const stillThere = await fs.lstat(path.join(this.root, oldItem.imageRel)).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
        if (stillThere) fail('IO_ERROR', '系统废纸篓没有移走图片，操作已取消。');
        this.fileIdentities.delete(oldItem.imageRel);
        await this._syncDirectory('assets/images');
        journal.phase = 'trashed'; await this._journal(journal);
        await this._fault('after-trash', journal);
      }
      await this._fault('before-index-write', journal);
      // Verify every retained image and the new file before publishing the new index.
      for (const item of after.items) await this._image(item);
      await this._atomic(INDEX, journal.afterRaw, loaded.hash);
      journal.phase = 'index-written'; await this._journal(journal);
      await this._fault('after-index-write', journal);
      await this._record(journal, operation === 'remove' ? 'deleted' : 'replaced');
      await this._cleanTransaction(journal);
      this.indexHash = sha(Buffer.from(journal.afterRaw));
      return this._public(after);
    } catch (error) {
      if (error.crash) throw error;
      if (!prepared) {
        await this._cleanPreparation(txId);
        throw error;
      }
      try { await this._rollback(journal); } catch (rollbackError) {
        throw new LibraryError('RECOVERY_CONFLICT', '操作中断且恢复遇到外部文件变化；恢复记录已保留，请停止其他写入并重新载入。', rollbackError);
      }
      throw error;
    }
  }

  async _cleanTransaction(journal) {
    const relative = `${META}/transactions/${journal.txId}`;
    const directory = await this._safe(relative, 'directory');
    const entries = await fs.readdir(directory);
    for (const entry of entries) {
      // No recursive removal: unexpected files are retained for inspection.
      if (entry !== 'journal.json' && !/^image\.(png|jpg|webp)$/.test(entry) && !/^\.journal\.json-[0-9a-f-]+\.tmp$/.test(entry)) fail('RECOVERY_CONFLICT', '事务目录含未知文件，已保留恢复记录。');
      await fs.unlink(await this._safe(`${relative}/${entry}`, 'file'));
      this.fileIdentities.delete(`${relative}/${entry}`);
    }
    await fs.rmdir(directory);
    this.directoryIdentities.delete(relative);
    await this._syncDirectory(`${META}/transactions`);
  }

  async _cleanPreparation(txId) {
    for (const category of ['transactions', 'recovery']) {
      const relative = `${META}/${category}/${txId}`;
      let directory;
      try { directory = await this._safe(relative, 'directory'); } catch (error) { if (error.code === 'NOT_FOUND') continue; throw error; }
      const entries = await fs.readdir(directory);
      for (const entry of entries) {
        if (!/^image\.(png|jpg|webp)$/.test(entry) && !/^\.journal\.json-[0-9a-f-]+\.tmp$/.test(entry)) fail('RECOVERY_CONFLICT', '未完成的准备目录含未知文件，已保留原文件。');
        await fs.unlink(await this._safe(`${relative}/${entry}`, 'file'));
        this.fileIdentities.delete(`${relative}/${entry}`);
      }
      await fs.rmdir(directory);
      this.directoryIdentities.delete(relative);
      await this._syncDirectory(`${META}/${category}`);
    }
  }

  async _rollback(journal) {
    const actual = await this._read(INDEX).then(sha);
    const beforeHash = sha(Buffer.from(journal.beforeRaw)), afterHash = sha(Buffer.from(journal.afterRaw));
    if (actual !== beforeHash && actual !== afterHash) fail('RECOVERY_CONFLICT', '索引被其他程序更改，恢复没有覆盖它。');
    if (journal.oldItem) {
      const backup = await this._read(journal.backupRel, MAX_IMAGE);
      if (sha(backup) !== journal.oldItem.sha256 || backup.length !== journal.oldItem.size) fail('RECOVERY_CONFLICT', '图片恢复副本校验失败，原文件未被覆盖。');
      const oldPath = await this._safe(journal.oldItem.imageRel, 'file', true);
      const exists = await fs.lstat(oldPath).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) await this._image(journal.oldItem);
      else await this._writeExclusive(journal.oldItem.imageRel, backup);
    }
    if (actual === afterHash) await this._atomic(INDEX, journal.beforeRaw, afterHash);
    if (journal.installedImageRel) {
      const installed = await this._safe(journal.installedImageRel, 'file', true);
      const exists = await fs.lstat(installed).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) {
        const stat = await fs.lstat(installed);
        if (!journal.installedIdentity || stat.dev !== journal.installedIdentity.dev || stat.ino !== journal.installedIdentity.ino) fail('RECOVERY_CONFLICT', '新图片被外部替换，恢复没有删除它。');
        await this._image(journal.newItem);
        await fs.unlink(await this._safe(journal.installedImageRel, 'file')); this.fileIdentities.delete(journal.installedImageRel); await this._syncDirectory('assets/images');
      }
    }
    await this._record(journal, 'rolled-back');
    await this._cleanTransaction(journal);
    this.indexHash = beforeHash;
  }

  _validateJournal(value, txId) {
    if (!isObject(value) || value.schemaVersion !== 1 || value.txId !== txId || !UUID.test(txId) || value.root !== this.root || !['create', 'update', 'remove'].includes(value.operation) || !['prepared', 'image-installed', 'trashing', 'trashed', 'index-written'].includes(value.phase) || typeof value.beforeRaw !== 'string' || typeof value.afterRaw !== 'string') fail('RECOVERY_CONFLICT', '事务恢复记录格式无效，文件已保留。');
    validateIndex(value.before); validateIndex(value.after);
    let beforeRaw, afterRaw;
    try { beforeRaw = JSON.parse(value.beforeRaw); afterRaw = JSON.parse(value.afterRaw); } catch { fail('RECOVERY_CONFLICT', '事务索引副本无效，文件已保留。'); }
    if (JSON.stringify(beforeRaw) !== JSON.stringify(value.before) || JSON.stringify(afterRaw) !== JSON.stringify(value.after) || value.after.revision !== value.before.revision + 1) fail('RECOVERY_CONFLICT', '事务索引副本不一致，文件已保留。');
    const id = value.oldItem?.id || value.newItem?.id;
    const oldItem = value.before.items.find(item => item.id === id) || null;
    const newItem = value.after.items.find(item => item.id === id) || null;
    if (!idValid(id) || JSON.stringify(oldItem) !== JSON.stringify(value.oldItem) || JSON.stringify(newItem) !== JSON.stringify(value.newItem) || value.operation === 'create' && (oldItem || !newItem) || value.operation === 'remove' && (!oldItem || newItem) || value.operation === 'update' && (!oldItem || !newItem)) fail('RECOVERY_CONFLICT', '事务素材记录无效，文件已保留。');
    const stable = items => items.filter(item => item.id !== id).sort((a, b) => a.id - b.id);
    if (JSON.stringify(stable(value.before.items)) !== JSON.stringify(stable(value.after.items)) || newItem && newItem.revision !== (oldItem ? oldItem.revision + 1 : 1)) fail('RECOVERY_CONFLICT', '事务包含不相关素材的变化，已保留原文件。');
    const generatedImage = newItem ? `${String(newItem.id).padStart(6, '0')}-${txId}.${mimeExtensions[newItem.mime]}` : null;
    if (value.installedImageRel !== null && (!newItem || value.installedImageRel !== newItem.imageRel || newItem.image !== generatedImage || oldItem?.imageRel === newItem.imageRel || !isObject(value.installedIdentity) || !Number.isSafeInteger(value.installedIdentity.dev) || !Number.isSafeInteger(value.installedIdentity.ino)) || value.installedImageRel === null && (value.installedIdentity !== null || value.operation === 'create' || newItem && ['image', 'imageRel', 'mime', 'size', 'sha256'].some(key => newItem[key] !== oldItem[key]))) fail('RECOVERY_CONFLICT', '事务新图片路径无效，文件已保留。');
    if (value.stageRel !== (value.installedImageRel ? `${META}/transactions/${txId}/image.${mimeExtensions[newItem.mime]}` : null)) fail('RECOVERY_CONFLICT', '事务导入副本路径无效，文件已保留。');
    const backup = oldItem ? `${META}/recovery/${txId}/image.${mimeExtensions[oldItem.mime]}` : null;
    if (value.backupRel !== backup) fail('RECOVERY_CONFLICT', '事务恢复图片路径无效，文件已保留。');
    return value;
  }

  async _recover() {
    const transactions = await this._safe(`${META}/transactions`, 'directory');
    const entries = await fs.readdir(transactions);
    for (const txId of entries.sort()) {
      if (!UUID.test(txId)) fail('RECOVERY_CONFLICT', '事务目录含未知文件，已保留原文件。');
      const directory = await this._safe(`${META}/transactions/${txId}`, 'directory');
      let journal;
      try { journal = this._validateJournal(JSON.parse((await this._read(`${META}/transactions/${txId}/journal.json`, MAX_INDEX * 4)).toString('utf8')), txId); } catch (error) {
        if (error.code === 'NOT_FOUND') { await this._cleanPreparation(txId); continue; }
        if (error instanceof LibraryError) throw error;
        fail('RECOVERY_CONFLICT', '事务恢复文件无法读取，已保留原文件。');
      }
      const actual = await this._read(INDEX).then(sha);
      if (actual === sha(Buffer.from(journal.afterRaw))) {
        for (const item of journal.after.items) await this._image(item);
        if (journal.oldItem) {
          const backup = await this._read(journal.backupRel, MAX_IMAGE);
          if (sha(backup) !== journal.oldItem.sha256 || backup.length !== journal.oldItem.size || imageMime(backup) !== journal.oldItem.mime) fail('RECOVERY_CONFLICT', '已提交事务的恢复副本无效，记录已保留。');
        }
        await this._record(journal, journal.operation === 'remove' ? 'deleted' : 'replaced');
        await this._cleanTransaction(journal);
        this.indexHash = actual;
      } else await this._rollback(journal);
    }
  }
}

module.exports = { LocalLibrary, LibraryError, validateIndex, imageMime };
