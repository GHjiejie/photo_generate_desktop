'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { discoverBatchDirectory, prepareDirectoryBatchImport, revalidateBatchImport, BatchImportError, CAPS } = require('../batch-import.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxkAAAAASUVORK5CYII=', 'base64');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const row = (id, image, extra = {}) => ({ id, ...(image === undefined ? {} : { image }), label: `原名称 ${id}`,
  prompt_en: ` Exact English ${id}\n  keep spaces `, prompt_cn: ` 原中文 ${id}\n  全文保留 `,
  extra: { original: ['all', { fields: true }] }, ...extra });
const errorCode = code => error => error instanceof BatchImportError && error.code === code;

async function fixture(t, files) {
  const requested = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-directory-plan-'));
  const root = await fs.realpath(requested);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, bytes) => {
    const filename = path.join(root, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes);
    return filename;
  };
  for (const [name, value] of Object.entries(files)) await write(name, value);
  return { root, write, discover: () => discoverBatchDirectory({ directory: root }),
    prepare: async options => prepareDirectoryBatchImport({ discovery: await discoverBatchDirectory({ directory: root }), ...options }) };
}

test('one selected root discovers flat and nested images while preserving exact raw source bytes and fields', async t => {
  const originals = [row(3, '003-a.png'), row(1, 'images/001-a.png'), row(2, '002-b.png')];
  const bytes = Buffer.from(JSON.stringify(originals, null, 2) + '\n');
  const f = await fixture(t, { 'manifest.json': bytes, '003-a.png': PNG, 'images/001-a.png': PNG, 'images/deeper/002-002-b.png': PNG });
  const discovery = await f.discover();
  assert.deepEqual(discovery.manifests, [{ relativePath: 'manifest.json', recordCount: 3 }]);
  assert.equal(discovery.imageCount, 3);
  assert.equal(Object.isFrozen(discovery.manifests), true);
  let decoded = 0;
  const plan = await prepareDirectoryBatchImport({ discovery, validateImage: (bytes, info) => {
    assert.deepEqual(bytes, PNG); assert.ok(info.path.startsWith(f.root + path.sep)); decoded++; return true;
  } });
  assert.equal(decoded, 3);
  assert.deepEqual(plan.manifestBytes, bytes);
  assert.deepEqual(plan.records.map(record => [record.id, record.sourceFileName, record.sourceRelativePath, record.matchMethod]),
    [[3, '003-a.png', '003-a.png', 'exact'], [1, '001-a.png', 'images/001-a.png', 'exact'],
      [2, '002-002-b.png', 'images/deeper/002-002-b.png', 'duplicate-leading-id-prefix']]);
  for (const record of plan.records) {
    assert.deepEqual(record.originalMetadata, originals[record.recordIndex]);
    assert.equal(record.prompts.en, originals[record.recordIndex].prompt_en);
    assert.equal(record.prompts.zh, originals[record.recordIndex].prompt_cn);
    assert.equal(record.sourceImagePath, path.join(f.root, record.sourceRelativePath));
  }
  await revalidateBatchImport(plan);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'manifest.json')), bytes);
  assert.equal(sha(await fs.readFile(path.join(f.root, 'images/001-a.png'))), sha(PNG));
});

test('JSON arrays at nested locations are candidates; multiple manifests require explicit selection without guessing', async t => {
  const f = await fixture(t, { 'a.json': JSON.stringify([row(1, 'images/001-a.png')]),
    'metadata/b.json': JSON.stringify([row(2, 'images/002-b.png')]), 'images/001-a.png': PNG, 'images/002-b.png': PNG });
  const discovery = await f.discover();
  assert.deepEqual(discovery.manifests, [{ relativePath: 'a.json', recordCount: 1 }, { relativePath: 'metadata/b.json', recordCount: 1 }]);
  await assert.rejects(prepareDirectoryBatchImport({ discovery }), errorCode('MANIFEST_SELECTION_REQUIRED'));
  await assert.rejects(prepareDirectoryBatchImport({ discovery, manifestRelativePath: '../a.json' }), errorCode('INVALID_MANIFEST'));
  const plan = await prepareDirectoryBatchImport({ discovery, manifestRelativePath: 'metadata/b.json' });
  assert.deepEqual(plan.records.map(record => record.id), [2]);
  assert.equal(plan.manifestPath, path.join(f.root, 'metadata/b.json'));
  await revalidateBatchImport(plan);
});

test('generated-portraits images wrapper retains all root/record fields and reports all 50 missing Chinese prompts', async t => {
  const images = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, image: `${String(index + 1).padStart(3, '0')}-original.png`,
    label: `Original ${index + 1}`, category: 'original-source-category', prompt_file: `../unavailable-${index}.txt`,
    prompt: ` Complete original English ${index + 1}\n  preserve spaces `, width: 1, height: 1,
    format: 'PNG', sha256: sha(PNG), path: `/original/remote/location/${index + 1}.png` }));
  const wrapper = { source_file: '/unavailable/source.json', count_requested: 50, count_generated: 50,
    missing: [], bad: [], images };
  const bytes = Buffer.from(JSON.stringify(wrapper, null, 2) + '\n');
  const files = { 'generated_portraits_manifest.json': bytes };
  for (const image of images) files[`generated_portraits/${image.image}`] = PNG;
  const f = await fixture(t, files);
  const discovery = await f.discover();
  assert.deepEqual(discovery.manifests, [{ relativePath: 'generated_portraits_manifest.json', recordCount: 50 }]);
  assert.equal(discovery.imageCount, 50);
  const plan = await prepareDirectoryBatchImport({ discovery });
  assert.equal(plan.matchedCount, 50);
  assert.equal(plan.importableCount, 0);
  assert.deepEqual(plan.manifestBytes, bytes);
  assert.deepEqual(JSON.parse(plan.manifestBytes), wrapper);
  assert.equal(plan.recordResults.filter(record => record.issueCodes.includes('MISSING_PROMPT_ZH')).length, 50);
  assert.equal(plan.recordResults.filter(record => record.sourceRelativePath.startsWith('generated_portraits/')).length, 50);
  assert.equal(plan.recordResults.every(record => record.matchMethod === 'exact'), true);
  assert.equal(plan.issues.some(issue => issue.code === 'INVALID_PROMPT_EN' || issue.code === 'MISSING_PROMPT_EN'), false);
  await revalidateBatchImport(plan);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'generated_portraits_manifest.json')), bytes);

  // A bilingual wrapper produces ordinary importable records; raw metadata is literal.
  const bilingual = { ...wrapper, images: [{ ...images[0], prompt_cn: '原文中文\n完整保留' }] };
  await f.write('generated_portraits_manifest.json', JSON.stringify(bilingual));
  const usable = await f.prepare();
  assert.equal(usable.records.length, 1);
  assert.deepEqual(usable.records[0].originalMetadata, bilingual.images[0]);
  assert.deepEqual(usable.records[0].prompts, { en: images[0].prompt, zh: bilingual.images[0].prompt_cn });
});

test('missing or invalid manifest has a recoverable error; invalid JSON is reported beside a valid candidate', async t => {
  const missing = await fixture(t, { '001-a.png': PNG });
  await assert.rejects(missing.discover(), errorCode('NO_MANIFEST'));
  const invalid = await fixture(t, { 'bad.json': '{ broken', 'object.json': '{}', 'empty.json': '[]', '001-a.png': PNG });
  await assert.rejects(invalid.discover(), errorCode('INVALID_MANIFEST'));
  await invalid.write('good.json', JSON.stringify([row(1, '001-a.png')]));
  const discovery = await invalid.discover();
  assert.deepEqual(discovery.ignoredManifests, [{ relativePath: 'bad.json', code: 'INVALID_MANIFEST' },
    { relativePath: 'empty.json', code: 'MANIFEST_TOO_LARGE' }, { relativePath: 'object.json', code: 'INVALID_MANIFEST' }]);
  assert.equal((await prepareDirectoryBatchImport({ discovery })).records.length, 1);
});

test('candidate discovery does not validate record fields; normal preview identifies the record errors', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([null, { id: 1 }]) });
  const discovery = await f.discover();
  assert.equal(discovery.manifests[0].recordCount, 2);
  const plan = await prepareDirectoryBatchImport({ discovery });
  assert.ok(plan.recordResults[0].issueCodes.includes('INVALID_RECORD'));
  assert.ok(plan.recordResults[1].issueCodes.includes('IMAGE_NOT_FOUND'));
  let nested = {};
  for (let depth = 0; depth < 30; depth++) nested = { nested };
  await f.write('manifest.json', JSON.stringify([row(1, '001-a.png', { nested })]));
  const tooDeep = await f.discover();
  assert.equal(tooDeep.manifests.length, 1);
  await assert.rejects(prepareDirectoryBatchImport({ discovery: tooDeep }), errorCode('INVALID_MANIFEST'));
});

test('explicit paths resolve exactly and unique basenames never override directory-wide ambiguities', async t => {
  const rows = [row(1, 'one/shared.png'), row(2, 'two/shared.png'), row(3, 'shared.png'),
    row(4, 'images/004-missing.png'), row(5, undefined), row(6, '006-a.png')];
  const f = await fixture(t, { 'manifest.json': JSON.stringify(rows), 'one/shared.png': PNG, 'two/shared.png': PNG,
    'images/004-004-missing.png': PNG, 'one/005-a.png': PNG, 'two/005-b.png': PNG,
    'one/006-006-a.png': PNG, 'two/006-006-a.png': PNG });
  const plan = await f.prepare();
  assert.deepEqual(plan.records.map(record => record.id), [1, 2]);
  assert.ok(plan.recordResults[2].issueCodes.includes('AMBIGUOUS_IMAGE'));
  assert.ok(plan.recordResults[3].issueCodes.includes('IMAGE_NOT_FOUND')); // No rewriting an explicit path.
  assert.ok(plan.recordResults[4].issueCodes.includes('AMBIGUOUS_IMAGE'));
  assert.ok(plan.recordResults[5].issueCodes.includes('AMBIGUOUS_IMAGE'));
  assert.equal(plan.unpaired.some(image => image.sourceRelativePath === 'images/004-004-missing.png'), true);
});

test('duplicate keys, missing prompts and missing images remain explicit per-record failures', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '001-a.png'), row('1', '001-b.png'),
    row(2, '002-a.png', { prompt_cn: undefined }), row(3, '003-missing.png'),
    row(4, 'unique.png'), row(5, 'unique.png')]), 'images/001-a.png': PNG, 'images/001-b.png': PNG,
    'images/002-a.png': PNG, 'images/unique.png': PNG });
  const plan = await f.prepare();
  assert.equal(plan.records.length, 0);
  assert.ok(plan.recordResults[0].issueCodes.includes('DUPLICATE_ID'));
  assert.ok(plan.recordResults[2].issueCodes.includes('MISSING_PROMPT_ZH'));
  assert.ok(plan.recordResults[3].issueCodes.includes('IMAGE_NOT_FOUND'));
  assert.ok(plan.recordResults[4].issueCodes.includes('DUPLICATE_IMAGE_NAME'));
});

test('relative path escape, absolute paths, encoded aliases and conflicting names cannot authorize outside reads', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '../outside.png'), row(2, '/tmp/002-a.png'),
    row(3, 'images/../003-a.png'), row(4, 'images\\004-a.png'), row(5, 'images/005-a.png', { filename: '005-a.png' }),
    row(6, 'images//006-a.png')]), 'images/003-a.png': PNG, 'images/005-a.png': PNG });
  const plan = await f.prepare();
  assert.equal(plan.records.length, 0);
  for (const result of plan.recordResults) assert.ok(result.issueCodes.includes('INVALID_IMAGE_NAME'));
});

test('symlink roots fail; nested symlink images and directories are never followed', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, 'images/001-a.png'), row(2, 'link/002-b.png')]), 'images/001-a.png': PNG });
  const outside = await fixture(t, { '002-b.png': PNG });
  await fs.symlink(outside.root, path.join(f.root, 'link'));
  await fs.symlink(path.join(outside.root, '002-b.png'), path.join(f.root, 'images/001-link.png'));
  const discovery = await f.discover();
  assert.equal(discovery.imageCount, 1);
  const plan = await prepareDirectoryBatchImport({ discovery });
  assert.deepEqual(plan.records.map(record => record.id), [1]);
  assert.ok(plan.recordResults[1].issueCodes.includes('IMAGE_NOT_FOUND'));
  assert.ok(plan.issues.some(issue => issue.code === 'SOURCE_SYMLINK'));
  const linkRoot = path.join(outside.root, 'root-link');
  await fs.symlink(f.root, linkRoot);
  await assert.rejects(discoverBatchDirectory({ directory: linkRoot }), errorCode('UNSAFE_PATH'));
});

test('directory depth, all entry count, JSON candidate count and byte limits are bounded', async t => {
  const tooDeep = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '001-a.png')]), 'a/b/c/d/001-a.png': PNG });
  await assert.rejects(tooDeep.discover(), errorCode('DIRECTORY_TOO_DEEP'));
  const manyJson = await fixture(t, {});
  await Promise.all(Array.from({ length: CAPS.manifests + 1 }, (_, index) => manyJson.write(`${String(index).padStart(2, '0')}.json`, '[]')));
  await assert.rejects(manyJson.discover(), errorCode('TOO_MANY_MANIFESTS'));
  const oversize = await fixture(t, { 'manifest.json': '[]' });
  await fs.truncate(path.join(oversize.root, 'manifest.json'), CAPS.manifest + 1);
  await assert.rejects(oversize.discover(), errorCode('MANIFEST_TOO_LARGE'));
  const manyEntries = await fixture(t, {});
  // Bounded batches avoid an unbounded number of open fixture handles.
  for (let offset = 0; offset <= CAPS.entries; offset += 100) await Promise.all(
    Array.from({ length: Math.min(100, CAPS.entries + 1 - offset) }, (_, index) => manyEntries.write(`entry-${offset + index}.txt`, '')));
  await assert.rejects(manyEntries.discover(), errorCode('DIRECTORY_TOO_LARGE'));
  const jsonTotal = await fixture(t, {});
  const padded = Buffer.alloc(Math.floor(CAPS.totalManifestBytes / 3) + 1, 32);
  Buffer.from(JSON.stringify([row(1, '001-a.png')])).copy(padded);
  for (const name of ['a.json', 'b.json', 'c.json']) await jsonTotal.write(name, padded);
  await assert.rejects(jsonTotal.discover(), errorCode('MANIFEST_TOTAL_TOO_LARGE'));
});

test('discovery cannot be forged and new or changed subtree entries invalidate a pending preview', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, 'images/001-a.png')]), 'images/001-a.png': PNG });
  const discovery = await f.discover();
  await assert.rejects(prepareDirectoryBatchImport({ discovery: { ...discovery } }), errorCode('INVALID_DISCOVERY'));
  await f.write('images/added/001-a.png', PNG);
  await assert.rejects(prepareDirectoryBatchImport({ discovery }), errorCode('SOURCE_CHANGED'));
});

test('async decoder subtree replacement or additions abort prepare and never return a stale plan', async t => {
  for (const action of ['swap-directory', 'new-image', 'change-other-manifest', 'delete-image']) {
    const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, 'images/001-a.png')]), 'images/001-a.png': PNG, 'metadata.json': '{}' });
    const discovery = await f.discover();
    await assert.rejects(prepareDirectoryBatchImport({ discovery, validateImage: async () => {
      if (action === 'swap-directory') {
        await fs.rename(path.join(f.root, 'images'), path.join(f.root, 'old-images'));
        await f.write('images/001-a.png', PNG);
      } else if (action === 'new-image') await f.write('images/002-new.png', PNG);
      else if (action === 'change-other-manifest') await f.write('metadata.json', '{"changed":true}');
      else await fs.unlink(path.join(f.root, 'images/001-a.png'));
      return true;
    } }), errorCode('SOURCE_CHANGED'));
  }
});

test('commit revalidation catches nested manifest/images, same-name directory replacement and new files', async t => {
  for (const action of ['image', 'manifest', 'swap-directory', 'new-file']) {
    const f = await fixture(t, { 'metadata/manifest.json': JSON.stringify([row(1, 'images/001-a.png')]), 'images/001-a.png': PNG });
    const plan = await f.prepare();
    if (action === 'image') await f.write('images/001-a.png', Buffer.concat([PNG, Buffer.from('changed')]));
    if (action === 'manifest') await f.write('metadata/manifest.json', JSON.stringify([row(1, 'images/001-a.png', { label: 'changed' })]));
    if (action === 'swap-directory') {
      await fs.rename(path.join(f.root, 'images'), path.join(f.root, 'old-images'));
      await f.write('images/001-a.png', PNG);
    }
    if (action === 'new-file') await f.write('metadata/new.txt', 'new');
    await assert.rejects(revalidateBatchImport(plan), errorCode('SOURCE_CHANGED'));
  }
});

test('private directory plans reject mutated raw buffers or cloned authorization', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, 'images/001-a.png')]), 'images/001-a.png': PNG });
  const plan = await f.prepare();
  await assert.rejects(revalidateBatchImport({ ...plan }), errorCode('INVALID_PLAN'));
  plan.manifestBytes[0] ^= 1;
  await assert.rejects(revalidateBatchImport(plan), errorCode('INVALID_PLAN'));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'manifest.json'), 'utf8'))[0].id, 1);
});

test('explicit main-process translations fill all 50 absent Chinese prompts and preserve original sources/provenance', async t => {
  const images = Array.from({ length: 50 }, (_, index) => ({ id: index + 1, image: `${String(index + 1).padStart(3, '0')}-a.png`,
    label: `Source ${index + 1}`, prompt: ` Full original English ${index + 1}\n  literal spaces `,
    path: `/unavailable/source/${index}`, category: 'original', prompt_file: `../${index}.txt`, extra: { source: true } }));
  const wrapper = { source_file: '/unavailable/original.json', count_generated: 50, images, original_root_field: ['retain', 50] };
  const bytes = Buffer.from(JSON.stringify(wrapper, null, 2) + '\n');
  const files = { 'generated_portraits_manifest.json': bytes };
  const derivedChinesePrompts = {};
  for (const record of images) {
    files[`generated_portraits/${record.image}`] = PNG;
    derivedChinesePrompts[record.id] = ` 完整衍生中文 ${record.id}\n  保留空格 `;
  }
  const f = await fixture(t, files);
  const discovery = await f.discover();
  const ordinary = await prepareDirectoryBatchImport({ discovery });
  assert.equal(ordinary.importableCount, 0);
  assert.equal(ordinary.recordResults.filter(record => record.issueCodes.includes('MISSING_PROMPT_ZH')).length, 50);
  const plan = await prepareDirectoryBatchImport({ discovery, derivedChinesePrompts });
  assert.equal(plan.importableCount, 50);
  assert.equal(plan.counts.errors, 0);
  assert.equal(plan.issues.some(issue => issue.code === 'MISSING_PROMPT_ZH'), false);
  assert.deepEqual(plan.manifestBytes, bytes);
  for (const record of plan.records) {
    const original = images[record.recordIndex];
    assert.equal(record.id, original.id);
    assert.equal(record.prompts.en, original.prompt);
    assert.equal(record.prompts.zh, derivedChinesePrompts[record.id]);
    assert.deepEqual(record.promptOrigins, { en: 'prompt', zh: 'derived-translation' });
    assert.deepEqual(record.originalMetadata, original);
    assert.equal(Object.hasOwn(record.originalMetadata, 'prompt_cn'), false);
    assert.deepEqual(record.translationProvenance, { kind: 'derived-translation', origin: 'assistant-translation',
      sourceLanguage: 'en', targetLanguage: 'zh', sourcePromptField: 'prompt', sourcePromptSha256: sha(Buffer.from(original.prompt)),
      translatedPromptSha256: sha(Buffer.from(derivedChinesePrompts[record.id])), sourceId: original.id,
      recordIndex: record.recordIndex, manifestSha256: sha(bytes) });
    assert.equal(Object.isFrozen(record.translationProvenance), true);
  }
  await revalidateBatchImport(plan);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'generated_portraits_manifest.json')), bytes);
  assert.equal(sha(await fs.readFile(path.join(f.root, 'generated_portraits/001-a.png'))), sha(PNG));
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(f.root, 'generated_portraits_manifest.json'), 'utf8')).images[0], 'prompt_cn'), false);
  await f.write('generated_portraits/001-a.png', Buffer.concat([PNG, Buffer.from('source changed')]));
  await assert.rejects(revalidateBatchImport(plan), errorCode('SOURCE_CHANGED'));
});

test('derived translations cannot overwrite original Chinese, including malformed source Chinese or English', async t => {
  for (const promptFields of [{ prompt_cn: '来源原中文' }, { prompt_zh: '来源别名中文', prompt_cn: undefined },
    { prompts: { zh: '嵌套原中文' }, prompt_cn: undefined }, { prompt_cn: '' }, { prompt_cn: null },
    { prompt_cn: undefined, prompt_en: '' }]) {
    const record = row(1, '001-a.png', promptFields);
    const f = await fixture(t, { 'manifest.json': JSON.stringify([record]), 'images/001-a.png': PNG });
    await assert.rejects(f.prepare({ derivedChinesePrompts: { 1: '不能覆盖的衍生中文' } }), errorCode('INVALID_TRANSLATION'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'manifest.json'), 'utf8'))[0], JSON.parse(JSON.stringify(record)));
  }
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '001-a.png'), row(2, '002-a.png', { prompt_cn: undefined })]),
    'images/001-a.png': PNG, 'images/002-a.png': PNG });
  const plan = await f.prepare({ derivedChinesePrompts: { 2: '第二条衍生中文' } });
  assert.equal(plan.records[0].prompts.zh, row(1, '001-a.png').prompt_cn);
  assert.equal(Object.hasOwn(plan.records[0], 'translationProvenance'), false);
  assert.equal(plan.records[1].prompts.zh, '第二条衍生中文');
});

test('translation mappings require full exact coverage and unique valid source IDs', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '001-a.png', { prompt_cn: undefined }), row(2, '002-a.png', { prompt_cn: undefined })]),
    'images/001-a.png': PNG, 'images/002-a.png': PNG });
  for (const derivedChinesePrompts of [{}, { 1: '一' }, { 1: '一', 3: '错误编号' }, { 1: '一', 2: '二', 3: '未知编号' },
    { '01': '一', 2: '二' }, { '-1': '一', 2: '二' }, { '1000000': '一', 2: '二' }]) {
    await assert.rejects(f.prepare({ derivedChinesePrompts }), errorCode('INVALID_TRANSLATION'));
  }
  for (const rows of [[row(1, '001-a.png', { prompt_cn: undefined }), row('1', '001-b.png', { prompt_cn: undefined })],
    [row(0, '001-a.png', { prompt_cn: undefined })], [row('bad', '001-a.png', { prompt_cn: undefined })], [null]]) {
    const bad = await fixture(t, { 'manifest.json': JSON.stringify(rows), 'images/001-a.png': PNG });
    await assert.rejects(bad.prepare({ derivedChinesePrompts: { 1: '中文' } }), errorCode('INVALID_TRANSLATION'));
  }
});

test('translation text and mapping shape are strictly bounded without evaluating getters', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '001-a.png', { prompt_cn: undefined })]), 'images/001-a.png': PNG });
  let getterCalled = false;
  const getter = Object.defineProperty({}, '1', { enumerable: true, get() { getterCalled = true; return '不能读取'; } });
  const hidden = Object.defineProperty({}, '1', { enumerable: false, value: '隐藏条目' });
  const symbol = { 1: '中文', [Symbol('unknown')]: '不可用' };
  for (const derivedChinesePrompts of [null, [], new Map([[1, '中文']]), Object.assign(Object.create({ extra: true }), { 1: '中文' }),
    getter, hidden, symbol, { 1: '' }, { 1: ' \n\t' }, { 1: '中文\0内容' }, { 1: '中'.repeat(CAPS.prompt + 1) },
    { 1: 42 }, { 1: ['中文'] }]) {
    await assert.rejects(f.prepare({ derivedChinesePrompts }), errorCode('INVALID_TRANSLATION'));
  }
  assert.equal(getterCalled, false);
  const limit = '中'.repeat(CAPS.prompt);
  const plan = await f.prepare({ derivedChinesePrompts: { 1: limit } });
  assert.equal(plan.records[0].prompts.zh, limit);
});

test('derivations are snapshotted before async decoding and frozen private plans remain unforgeable', async t => {
  const f = await fixture(t, { 'manifest.json': JSON.stringify([row(1, '001-a.png', { prompt_cn: undefined })]), 'images/001-a.png': PNG });
  const translations = { 1: '原授权衍生中文\n完整保留' };
  const plan = await f.prepare({ derivedChinesePrompts: translations, validateImage: () => { translations[1] = '后续调用者修改'; return true; } });
  assert.equal(plan.records[0].prompts.zh, '原授权衍生中文\n完整保留');
  assert.equal(plan.records[0].translationProvenance.translatedPromptSha256, sha(Buffer.from('原授权衍生中文\n完整保留')));
  assert.throws(() => { plan.records[0].translationProvenance.sourceId = 99; }, TypeError);
  await revalidateBatchImport(plan);
  await assert.rejects(revalidateBatchImport({ ...plan }), errorCode('INVALID_PLAN'));
  plan.manifestBytes[0] ^= 1;
  await assert.rejects(revalidateBatchImport(plan), errorCode('INVALID_PLAN'));
});
