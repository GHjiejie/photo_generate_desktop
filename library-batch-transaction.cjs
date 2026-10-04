// A separate journal keeps additive batch imports independent of CRUD/Trash recovery.
module.exports = function batchTransactions(deps) {
  const { fs, constants, path, crypto, LibraryError, fail, sha, encode, clone, isObject, metadata,
    validateIndex, imageMime, MAX_IMAGE, MAX_INDEX, INDEX, META, UUID, HASH, NOFOLLOW, mimeExtensions } = deps;
  const TRANSACTIONS = `${META}/batch-transactions`;
  const IMPORTS = `${META}/imports`;
  const MAX_RECORDS = 500;
  const MAX_TOTAL = 1024 * 1024 * 1024;
  const own = value => Object.prototype.hasOwnProperty.call(value, 'sourceMetadata');
  const stable = value => JSON.stringify(value, function (key, item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
    return item;
  });
  const canceled = signal => { if (signal?.aborted) fail('ABORTED', '批量导入已取消，素材库没有提交变化。'); };

  async function noLinks(absolute, type) {
    if (typeof absolute !== 'string' || !path.isAbsolute(absolute) || absolute.includes('\0') || path.resolve(absolute) !== absolute) fail('UNSAFE_PATH', '批量导入来源路径无效。');
    let current = path.parse(absolute).root;
    const parts = absolute.slice(current.length).split('/');
    let stat;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || i < parts.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH', '批量导入来源不能包含符号链接。');
    }
    if (await fs.realpath(absolute) !== absolute || type === 'file' && !stat.isFile() || type === 'directory' && !stat.isDirectory()) fail('UNSAFE_PATH', '批量导入来源的文件类型或路径无效。');
    return stat;
  }

  async function sourceRead(absolute, limit, expected) {
    const pathStat = await noLinks(absolute, 'file');
    const handle = await fs.open(absolute, constants.O_RDONLY | NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || expected && (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size)) fail('SOURCE_CHANGED', '导入来源被替换，请重新预览。');
      if (before.size < 1 || before.size > limit) fail('INVALID_DATA', '批量导入文件超过允许大小。');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
        if (!read.bytesRead) fail('SOURCE_CHANGED', '导入来源长度已变化，请重新预览。');
        offset += read.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead) fail('SOURCE_CHANGED', '导入来源长度已变化，请重新预览。');
      const after = await handle.stat();
      const final = await noLinks(absolute, 'file');
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.dev !== final.dev || before.ino !== final.ino || before.mtimeMs !== final.mtimeMs || before.ctimeMs !== final.ctimeMs) fail('SOURCE_CHANGED', '导入来源已变化，请重新预览。');
      return bytes;
    } finally { await handle.close(); }
  }

  async function revalidate(plan) {
    try { await require('./batch-import.cjs').revalidateBatchImport(plan); }
    catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError(error.code || 'INVALID_DATA', error.message || '批量导入来源校验失败。', error); }
  }

  async function validatePlan(plan, signal) {
    canceled(signal);
    if (!isObject(plan) || !Array.isArray(plan.records) || plan.records.length > MAX_RECORDS || !Buffer.isBuffer(plan.manifestBytes) || !plan.manifestBytes.length || plan.manifestBytes.length > MAX_INDEX || !HASH.test(plan.manifestSha256 || '') || sha(plan.manifestBytes) !== plan.manifestSha256) fail('INVALID_DATA', '批量导入计划或原始清单无效。');
    await revalidate(plan);
    canceled(signal);
    const sourceRoot = await noLinks(plan.sourceDirectory, 'directory');
    const manifest = await sourceRead(plan.manifestPath, MAX_INDEX);
    if (sha(manifest) !== plan.manifestSha256 || !manifest.equals(plan.manifestBytes)) fail('SOURCE_CHANGED', '原始 JSON 清单已变化，请重新预览。');
    let raw;
    try { raw = JSON.parse(manifest.toString('utf8')); } catch { fail('INVALID_DATA', '原始清单不是有效 JSON。'); }
    if (!Array.isArray(raw) || raw.length > MAX_RECORDS) fail('INVALID_DATA', '原始清单必须是最多 500 条记录的 JSON 数组。');
    let total = 0;
    const ids = new Set(), indices = new Set();
    for (const record of plan.records) {
      metadata(record);
      if (!isObject(record.originalMetadata) || !Number.isSafeInteger(record.recordIndex) || record.recordIndex < 0 || record.recordIndex >= raw.length || stable(record.originalMetadata) !== stable(raw[record.recordIndex]) || ids.has(record.id) || indices.has(record.recordIndex)) fail('INVALID_DATA', '批量记录与原始清单不一致或含重复编号。');
      ids.add(record.id); indices.add(record.recordIndex);
      if (typeof record.sourceFileName !== 'string' || record.sourceFileName.length > 255 || record.sourceFileName.includes('\0') || path.basename(record.sourceFileName) !== record.sourceFileName || !/\.(png|jpe?g|webp)$/i.test(record.sourceFileName) || record.sourceImagePath !== path.join(plan.sourceDirectory, record.sourceFileName) || !HASH.test(record.sha256 || '') || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > MAX_IMAGE || !Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino) || !Object.hasOwn(mimeExtensions, record.mime) || !['source', 'selected-default'].includes(record.typeOrigin)) fail('UNSAFE_PATH', '批量图片路径、分类来源或校验信息无效。');
      total += record.size;
      if (total > MAX_TOTAL) fail('INVALID_DATA', '一次批量导入图片不能超过 1 GiB。');
    }
    return { raw, sourceIdentity: { dev: sourceRoot.dev, ino: sourceRoot.ino } };
  }

  async function image(lib, record, signal) {
    canceled(signal);
    const bytes = await sourceRead(record.sourceImagePath, MAX_IMAGE, record);
    if (sha(bytes) !== record.sha256 || imageMime(bytes) !== record.mime) fail('SOURCE_CHANGED', '批量图片的内容或格式已变化，请重新预览。');
    if (lib.validateImage && await lib.validateImage(bytes, { mime: record.mime, size: bytes.length, path: record.sourceImagePath }) === false) fail('INVALID_IMAGE', '批量图片无法解码。');
    canceled(signal);
    return bytes;
  }

  function classify(index, plan) {
    const records = [];
    const byId = new Map(index.items.map(item => [item.id, item]));
    for (const record of plan.records) {
      const existing = byId.get(record.id);
      const same = existing && existing.sha256 === record.sha256 && existing.label === record.label && existing.type === record.type && stable(existing.prompts) === stable(record.prompts) && own(existing) && stable(existing.sourceMetadata) === stable(record.originalMetadata);
      const status = !existing ? 'import' : same ? 'skip' : 'conflict';
      records.push({ recordIndex: record.recordIndex, id: record.id, label: record.label, sourceFileName: record.sourceFileName,
        status, ...(status === 'conflict' ? { code: 'DUPLICATE_ID', message: '编号已存在且内容不同，保留现有素材。' } : {}),
        ...(existing ? { targetFileName: existing.image, archiveRel: existing.sourceImport?.archiveRel } : {}) });
    }
    const safeIndices = new Set(plan.records.map(record => record.recordIndex));
    for (const row of plan.recordResults || []) {
      if (safeIndices.has(row.index)) continue;
      records.push({ recordIndex: row.index, id: row.id, label: row.label, sourceFileName: row.sourceFileName, status: 'invalid', code: row.issueCodes?.[0] || 'INVALID_DATA', message: '原清单记录或图片配对不完整，本条不导入。' });
    }
    records.sort((a, b) => a.recordIndex - b.recordIndex);
    const summary = { total: plan.counts?.total ?? records.length, importable: 0, skipped: 0, conflicts: 0, invalid: 0 };
    for (const row of records) summary[{ import: 'importable', skip: 'skipped', conflict: 'conflicts', invalid: 'invalid' }[row.status]]++;
    return { revision: index.revision, summary, records, canImport: summary.importable > 0 };
  }

  async function preview(lib, plan) {
    await validatePlan(plan);
    const loaded = await lib._load();
    for (const record of plan.records) await image(lib, record);
    await revalidate(plan);
    return classify(loaded.index, plan);
  }

  function report(journal, status) {
    return { schemaVersion: 1, batchId: journal.txId, status, recordedAt: journal.createdAt, manifestSha256: journal.manifestSha256,
      beforeVersion: journal.before.revision, afterVersion: status === 'completed' ? journal.after.revision : journal.before.revision,
      imported: status === 'completed' ? journal.entries.length : 0, planned: journal.entries.length,
      skipped: journal.summary.skipped, conflicts: journal.summary.conflicts, invalid: journal.summary.invalid,
      records: journal.mapping };
  }

  async function writeJournal(lib, journal) {
    const encoded = encode(journal);
    if (Buffer.byteLength(encoded) > MAX_INDEX * 4) fail('INVALID_DATA', '批次恢复记录超过允许大小。');
    await lib._atomic(`${TRANSACTIONS}/${journal.txId}/journal.json`, encoded);
  }

  async function archiveState(lib, journal, status) {
    for (const file of journal.archiveFiles) {
      const bytes = await lib._read(`${journal.archiveRel}/${file.name}`, MAX_INDEX);
      if (sha(bytes) !== file.sha256) fail('RECOVERY_CONFLICT', '批次原始归档被外部更改，恢复记录已保留。');
    }
    const next = encode(report(journal, status));
    const reportRel = `${journal.archiveRel}/report.json`;
    const current = await lib._read(reportRel).then(sha).catch(error => { if (error.code === 'NOT_FOUND') return null; throw error; });
    const acceptable = ['pending', 'completed', 'rolled-back'].map(state => sha(Buffer.from(encode(report(journal, state)))));
    if (current !== null && !acceptable.includes(current)) fail('RECOVERY_CONFLICT', '批次报告被外部更改，恢复没有覆盖它。');
    await lib._atomic(reportRel, next, current);
  }

  async function removeOwned(lib, entry, relative, requiredHash = true) {
    const target = await lib._safe(relative, 'file', true);
    const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (!entry.identity || stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino) fail('RECOVERY_CONFLICT', '批次副本被外部替换，恢复没有删除它。');
    if (requiredHash) {
      const bytes = await lib._read(relative, MAX_IMAGE);
      if (sha(bytes) !== entry.item.sha256 || bytes.length !== entry.item.size || imageMime(bytes) !== entry.item.mime) fail('RECOVERY_CONFLICT', '批次副本被外部修改，恢复没有删除它。');
    }
    await fs.unlink(await lib._safe(relative, 'file'));
    lib.fileIdentities.delete(relative);
  }

  async function clean(lib, journal) {
    const txRel = `${TRANSACTIONS}/${journal.txId}`;
    const directory = await lib._safe(txRel, 'directory');
    // Unpublished partial copies are kept in the archive rather than leaving an
    // active transaction which would block the old library on every restart.
    // Delete only complete copies whose durable inode and full hash both match.
    for (const entry of journal.entries) {
      let target;
      try { target = await lib._safe(entry.stageRel, 'file', true); }
      catch (error) { if (error.code === 'NOT_FOUND') continue; throw error; }
      const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat || !entry.identity || stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino) continue;
      let bytes;
      try { bytes = await lib._read(entry.stageRel, MAX_IMAGE); }
      catch (error) { if (['CONFLICT', 'INVALID_DATA'].includes(error.code)) continue; throw error; }
      if (bytes.length !== entry.item.size || sha(bytes) !== entry.item.sha256) continue;
      await removeOwned(lib, entry, entry.stageRel);
    }
    const stagingRel = `${journal.archiveRel}/.staging`;
    try {
      const staging = await lib._safe(stagingRel, 'directory');
      if (!(await fs.readdir(staging)).length) { await fs.rmdir(staging); lib.directoryIdentities.delete(stagingRel); await lib._syncDirectory(journal.archiveRel); }
    } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    for (const name of await fs.readdir(directory)) {
      if (name === 'journal.json' || /^\.journal\.json-[0-9a-f-]+\.tmp$/.test(name)) {
        await fs.unlink(await lib._safe(`${txRel}/${name}`, 'file'));
        lib.fileIdentities.delete(`${txRel}/${name}`);
      } else fail('RECOVERY_CONFLICT', '批次事务目录含未知文件，已保留记录。');
    }
    await fs.rmdir(directory);
    lib.directoryIdentities.delete(txRel);
    await lib._syncDirectory(TRANSACTIONS);
  }

  async function cleanEmptyPreparation(lib, txId) {
    const relative = `${TRANSACTIONS}/${txId}`;
    const directory = await lib._safe(relative, 'directory');
    for (const name of await fs.readdir(directory)) {
      if (!/^\.journal\.json-[0-9a-f-]+\.tmp$/.test(name)) fail('RECOVERY_CONFLICT', '未完成批次目录含未知文件，已保留原文件。');
      await fs.unlink(await lib._safe(`${relative}/${name}`, 'file'));
      lib.fileIdentities.delete(`${relative}/${name}`);
    }
    await fs.rmdir(directory); lib.directoryIdentities.delete(relative); await lib._syncDirectory(TRANSACTIONS);
  }

  async function rollback(lib, journal) {
    const actual = sha(await lib._read(INDEX));
    const beforeHash = sha(Buffer.from(journal.beforeRaw)), afterHash = sha(Buffer.from(journal.afterRaw));
    if (actual !== beforeHash && actual !== afterHash) fail('RECOVERY_CONFLICT', '素材索引被外部修改，批次恢复没有覆盖它。');
    // Validate every owned live copy before reverting the index or removing anything.
    for (const entry of journal.entries) {
      const target = await lib._safe(entry.item.imageRel, 'file', true);
      const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat) {
        if (!entry.identity || stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino) fail('RECOVERY_CONFLICT', '批次新图片被外部替换，恢复没有删除它。');
        await lib._image(entry.item);
      }
    }
    if (actual === afterHash) await lib._atomic(INDEX, journal.beforeRaw, afterHash);
    for (const entry of journal.entries) await removeOwned(lib, entry, entry.item.imageRel);
    await lib._syncDirectory('assets/images');
    await archiveState(lib, journal, 'rolled-back');
    await clean(lib, journal);
    lib.indexHash = beforeHash;
  }

  function validateJournal(lib, value, txId) {
    if (!isObject(value) || value.schemaVersion !== 1 || value.operation !== 'batch-import' || !UUID.test(txId) || value.txId !== txId || value.root !== lib.root || !['prepared', 'image-installed', 'index-written'].includes(value.phase) || typeof value.archiveReady !== 'boolean' || value.archiveRel !== `${IMPORTS}/${txId}` || !HASH.test(value.manifestSha256 || '') || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > MAX_RECORDS || !Array.isArray(value.archiveFiles) || !Array.isArray(value.mapping) || !isObject(value.summary)) fail('RECOVERY_CONFLICT', '批次事务格式无效，记录已保留。');
    validateIndex(value.before); validateIndex(value.after);
    if (typeof value.beforeRaw !== 'string' || typeof value.afterRaw !== 'string' || stable(JSON.parse(value.beforeRaw)) !== stable(value.before) || stable(JSON.parse(value.afterRaw)) !== stable(value.after) || value.after.revision !== value.before.revision + 1) fail('RECOVERY_CONFLICT', '批次索引副本不一致，记录已保留。');
    const additions = new Set();
    for (const entry of value.entries) {
      const item = entry.item;
      const filename = `${String(item?.id).padStart(6, '0')}-${txId}.${mimeExtensions[item?.mime]}`;
      if (!item || additions.has(item.id) || value.before.items.some(old => old.id === item.id) || item.revision !== 1 || item.image !== filename || item.imageRel !== `assets/images/${filename}` || item.sourceImport?.archiveRel !== value.archiveRel || entry.stageRel !== `${value.archiveRel}/.staging/image-${item.id}.${mimeExtensions[item.mime]}` || typeof entry.ready !== 'boolean' || entry.ready && (!entry.identity || !value.archiveReady) || entry.identity !== null && (!isObject(entry.identity) || !Number.isSafeInteger(entry.identity.dev) || !Number.isSafeInteger(entry.identity.ino)) || stable(value.after.items.find(row => row.id === item.id)) !== stable(item)) fail('RECOVERY_CONFLICT', '批次新增图片或来源记录无效。');
      additions.add(item.id);
    }
    const sortItems = items => [...items].sort((a, b) => a.id - b.id);
    if (value.after.items.length !== value.before.items.length + additions.size || stable(sortItems(value.after.items.filter(item => !additions.has(item.id)))) !== stable(sortItems(value.before.items))) fail('RECOVERY_CONFLICT', '批次包含现有素材的修改，记录已保留。');
    const expectedNames = ['manifest.json', 'mapping.json', 'source.json'];
    if (value.archiveFiles.length !== expectedNames.length || expectedNames.some(name => value.archiveFiles.filter(file => file.name === name && HASH.test(file.sha256 || '')).length !== 1) || value.archiveFiles.find(file => file.name === 'manifest.json').sha256 !== value.manifestSha256) fail('RECOVERY_CONFLICT', '批次归档校验信息无效。');
    return value;
  }

  async function recover(lib) {
    let directory;
    try { directory = await lib._safe(TRANSACTIONS, 'directory'); } catch (error) { if (error.code === 'NOT_FOUND') return; throw error; }
    for (const txId of (await fs.readdir(directory)).sort()) {
      if (!UUID.test(txId)) fail('RECOVERY_CONFLICT', '批次事务目录含未知文件，已保留记录。');
      let journal;
      try { journal = validateJournal(lib, JSON.parse((await lib._read(`${TRANSACTIONS}/${txId}/journal.json`, MAX_INDEX * 4)).toString('utf8')), txId); }
      catch (error) {
        if (error.code === 'NOT_FOUND') { await cleanEmptyPreparation(lib, txId); continue; }
        if (error instanceof LibraryError) throw error;
        fail('RECOVERY_CONFLICT', '批次恢复文件无法读取，已保留记录。');
      }
      const actual = sha(await lib._read(INDEX));
      if (!journal.archiveReady) {
        if (actual !== sha(Buffer.from(journal.beforeRaw)) || journal.entries.some(entry => entry.identity || entry.ready)) fail('RECOVERY_CONFLICT', '未完成归档含已发布状态，恢复记录已保留。');
        for (const entry of journal.entries) {
          const live = await lib._safe(entry.item.imageRel, 'file', true);
          if (await fs.lstat(live).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) fail('RECOVERY_CONFLICT', '未完成归档出现外部目标图片，恢复没有触碰它。');
        }
        // Preserve incomplete raw JSON exactly as found; never label it as a
        // verified complete archive or overwrite a partially written report.
        await clean(lib, journal); lib.indexHash = actual; continue;
      }
      if (actual === sha(Buffer.from(journal.beforeRaw)) && journal.entries.every(entry => entry.identity === null)) {
        // A stop while archiving cannot have published an image. Keep partial archive
        // evidence; unknown or incomplete staged files are preserved by clean().
        try { await archiveState(lib, journal, 'rolled-back'); } catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
        await clean(lib, journal);
        lib.indexHash = actual;
        continue;
      }
      if (actual === sha(Buffer.from(journal.afterRaw))) {
        for (const item of journal.after.items) await lib._image(item);
        await archiveState(lib, journal, 'completed');
        await clean(lib, journal);
        lib.indexHash = actual;
      } else await rollback(lib, journal);
    }
  }

  async function importBatch(lib, plan, options) {
    if (!isObject(options) || Object.keys(options).some(key => !['expectedVersion', 'confirmed', 'signal'].includes(key)) || options.confirmed !== true) fail('CONFIRMATION_REQUIRED', '请确认预览后再导入批次。');
    const { signal } = options;
    const validation = await validatePlan(plan, signal);
    const loaded = await lib._load();
    lib._compare(loaded.index, options);
    const previewed = classify(loaded.index, plan);
    // Idempotent retries and all-conflict batches do not write another archive.
    if (!previewed.canImport) {
      for (const record of plan.records) await image(lib, record, signal);
      await revalidate(plan); canceled(signal);
      return { ...lib._public(loaded.index), batch: { imported: 0, skipped: previewed.summary.skipped, conflicts: previewed.summary.conflicts, invalid: previewed.summary.invalid,
        archiveRel: previewed.records.find(row => row.archiveRel)?.archiveRel, mapping: previewed.records, report: { status: 'unchanged', records: previewed.records } } };
    }
    const txId = crypto.randomUUID(), txRel = `${TRANSACTIONS}/${txId}`, archiveRel = `${IMPORTS}/${txId}`;
    const createdAt = new Date().toISOString();
    const selectedIds = new Set(previewed.records.filter(row => row.status === 'import').map(row => row.id));
    const selected = plan.records.filter(record => selectedIds.has(record.id));
    const entries = selected.map(record => {
      const filename = `${String(record.id).padStart(6, '0')}-${txId}.${mimeExtensions[record.mime]}`;
      return { item: { ...metadata(record), image: filename, imageRel: `assets/images/${filename}`, revision: 1, sha256: record.sha256, size: record.size, mime: record.mime,
        sourceMetadata: clone(record.originalMetadata), sourceImport: { archiveRel, manifestSha256: plan.manifestSha256, sourceHash: record.sha256, recordIndex: record.recordIndex, sourceFileName: record.sourceFileName, typeOrigin: record.typeOrigin, matchMethod: record.matchMethod } },
        stageRel: `${archiveRel}/.staging/image-${record.id}.${mimeExtensions[record.mime]}`, identity: null, ready: false };
    });
    const after = validateIndex({ ...clone(loaded.index), revision: loaded.index.revision + 1, updatedAt: createdAt, items: [...loaded.index.items, ...entries.map(entry => entry.item)].sort((a, b) => a.id - b.id) });
    const afterRaw = encode(after);
    if (Buffer.byteLength(afterRaw) > MAX_INDEX) fail('INVALID_DATA', '导入后素材索引超过 32 MiB，批次没有提交。');
    const mapping = previewed.records.map(row => row.status === 'import' ? { ...row, targetFileName: entries.find(entry => entry.item.id === row.id).item.image, targetImageRel: entries.find(entry => entry.item.id === row.id).item.imageRel, sourceHash: selected.find(record => record.id === row.id).sha256 } : row);
    const archiveBytes = [
      { name: 'manifest.json', bytes: Buffer.from(plan.manifestBytes) },
      { name: 'mapping.json', bytes: Buffer.from(encode(mapping)) },
      { name: 'source.json', bytes: Buffer.from(encode({ schemaVersion: 1, batchId: txId, manifestPath: plan.manifestPath, sourceDirectory: plan.sourceDirectory, manifestSha256: plan.manifestSha256, pins: plan.pins, issues: plan.issues || [], unpaired: plan.unpaired || [] })) }
    ];
    const journal = { schemaVersion: 1, operation: 'batch-import', txId, root: lib.root, createdAt, phase: 'prepared', archiveReady: false, archiveRel, manifestSha256: plan.manifestSha256,
      before: loaded.index, beforeRaw: loaded.raw, after, afterRaw, entries, mapping, summary: previewed.summary, archiveFiles: archiveBytes.map(file => ({ name: file.name, sha256: sha(file.bytes) })) };
    // The journal is durable before a staged or live image is created.
    await lib._mkdir(TRANSACTIONS); await lib._mkdir(IMPORTS); await lib._mkdir(txRel);
    await writeJournal(lib, journal);
    let archiveReady = false;
    try {
      await lib._mkdir(archiveRel);
      for (const file of archiveBytes) {
        if (file.name !== 'manifest.json') { await lib._writeExclusive(`${archiveRel}/${file.name}`, file.bytes); continue; }
        const relative = `${archiveRel}/${file.name}`;
        const handle = await fs.open(await lib._safe(relative, 'file', true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        try {
          await lib._fault('batch-after-manifest-create', journal);
          const half = Math.ceil(file.bytes.length / 2);
          await handle.writeFile(file.bytes.subarray(0, half)); await handle.sync();
          await lib._fault('batch-during-manifest-write', journal);
          await handle.writeFile(file.bytes.subarray(half)); await handle.sync();
          await lib._syncDirectory(archiveRel);
          await lib._fault('batch-after-manifest-write', journal);
        } finally { await handle.close(); lib.fileIdentities.delete(relative); }
      }
      await archiveState(lib, journal, 'pending');
      journal.archiveReady = true; await writeJournal(lib, journal); archiveReady = true;
      await lib._fault('batch-after-archive', journal);
      await lib._mkdir(`${archiveRel}/.staging`);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index], record = selected[index];
        const bytes = await image(lib, record, signal);
        const handle = await fs.open(await lib._safe(entry.stageRel, 'file', true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        try {
          await lib._fault('batch-after-stage-create', journal);
          const owned = await handle.stat(); entry.identity = { dev: owned.dev, ino: owned.ino };
          // This durable inode record precedes all writes and any live linking.
          await writeJournal(lib, journal);
          await lib._fault('batch-before-stage-write', journal);
          const half = Math.ceil(bytes.length / 2);
          await handle.writeFile(bytes.subarray(0, half)); await handle.sync();
          await lib._fault('batch-during-stage-write', journal);
          await handle.writeFile(bytes.subarray(half)); await handle.sync();
          await lib._syncDirectory(`${archiveRel}/.staging`);
          await lib._fault('batch-after-stage-write', journal);
        } finally { await handle.close(); lib.fileIdentities.delete(entry.stageRel); }
        entry.ready = true; await writeJournal(lib, journal);
        canceled(signal);
        const staged = await lib._read(entry.stageRel, MAX_IMAGE);
        if (sha(staged) !== entry.item.sha256 || staged.length !== entry.item.size) fail('CONFLICT', '批次暂存图片被修改，导入已停止。');
        const stagedIdentity = await fs.lstat(await lib._safe(entry.stageRel, 'file'));
        if (stagedIdentity.dev !== entry.identity.dev || stagedIdentity.ino !== entry.identity.ino) fail('CONFLICT', '批次暂存图片被替换，导入已停止。');
        await fs.link(await lib._safe(entry.stageRel, 'file'), await lib._safe(entry.item.imageRel, 'file', true));
        lib.fileIdentities.delete(entry.item.imageRel);
        await lib._syncDirectory('assets/images');
        journal.phase = 'image-installed'; await writeJournal(lib, journal);
        await lib._fault('batch-after-image-install', journal);
      }
      await lib._fault('batch-before-index-write', journal);
      await revalidate(plan); canceled(signal);
      const sourceRoot = await noLinks(plan.sourceDirectory, 'directory');
      if (sourceRoot.dev !== validation.sourceIdentity.dev || sourceRoot.ino !== validation.sourceIdentity.ino) fail('SOURCE_CHANGED', '导入来源目录被替换，请重新预览。');
      for (const entry of entries) {
        const installed = await fs.lstat(await lib._safe(entry.item.imageRel, 'file'));
        if (installed.dev !== entry.identity.dev || installed.ino !== entry.identity.ino) fail('CONFLICT', '批次新增图片被替换，导入没有提交。');
      }
      for (const item of after.items) await lib._image(item);
      canceled(signal);
      await lib._atomic(INDEX, afterRaw, loaded.hash);
      // After the single index commit, cancellation does not claim the batch was uncommitted.
      journal.phase = 'index-written'; await writeJournal(lib, journal);
      await lib._fault('batch-after-index-write', journal);
      await archiveState(lib, journal, 'completed');
      await clean(lib, journal);
      lib.indexHash = sha(Buffer.from(afterRaw));
      return { ...lib._public(after), batch: { batchId: txId, archiveRel, imported: entries.length, skipped: previewed.summary.skipped, conflicts: previewed.summary.conflicts, invalid: previewed.summary.invalid, mapping, report: report(journal, 'completed') } };
    } catch (error) {
      if (error.crash) throw error;
      try {
        if (archiveReady) await rollback(lib, journal);
        else {
          // No images have been created before the full archive is ready. Preserve partial
          // evidence and remove only this known journal, so another open is not blocked.
          if (entries.some(entry => entry.identity)) fail('RECOVERY_CONFLICT', '批次准备状态不一致，已保留记录。');
          await clean(lib, journal);
        }
      } catch (rollbackError) { throw new LibraryError('RECOVERY_CONFLICT', '批次中断且恢复遇到外部变化；原素材和恢复记录均已保留。', rollbackError); }
      throw error;
    }
  }

  return { preview, import: importBatch, recover };
};
