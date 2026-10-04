'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepareBatchImport, revalidateBatchImport, BatchImportError, CAPS } = require('../batch-import.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxkAAAAASUVORK5CYII=', 'base64');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = (id, image, extra = {}) => ({ id, image, label: `原标签 ${id}`, prompt: `alias ${id}`,
  prompt_en: ` Original English ${id}\n  second line `, prompt_cn: `原中文 ${id}\n  原文空格 `,
  prompt_file: `${image.slice(0, -4)}.txt`, image_url: `https://example.invalid/${image}`,
  nested: { unchanged: [1, 'two', { extra: true }] }, ...extra });
const errorCode = code => error => error instanceof BatchImportError && error.code === code;

async function fixture(t, records, imageNames, options = {}) {
  const requested = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-batch-parser-'));
  const root = await fs.realpath(requested);
  const images = path.join(root, 'images');
  await fs.mkdir(images);
  const manifest = path.join(root, 'manifest.json');
  const bytes = Buffer.from(JSON.stringify(records, null, 2) + '\n');
  await fs.writeFile(manifest, bytes);
  for (const name of imageNames) await fs.writeFile(path.join(images, name), PNG);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, images, manifest, bytes, prepare: overrides => prepareBatchImport({ imageDirectory: images,
    manifestPath: manifest, ...options, ...overrides }) };
}

test('exact, repeated-prefix and unique-id matching use IDs, preserve raw bytes and every raw field', async t => {
  const originals = [record(3, '003-expected.png'), record(1, '001-a.png'), record(2, '002-b.png')];
  delete originals[0].image; // ID-only fallback is allowed only without an explicit filename.
  const data = await fixture(t, originals, ['001-a.png', '002-002-b.png', '003-actual.png']);
  let decoded = 0;
  const plan = await data.prepare({ validateImage: (bytes, info) => { assert.deepEqual(bytes, PNG); assert.equal(info.mime, 'image/png'); decoded++; return true; } });
  assert.equal(decoded, 3);
  assert.deepEqual(plan.manifestBytes, data.bytes);
  assert.equal(plan.manifestSha256, sha(data.bytes));
  assert.deepEqual(plan.counts, { total: 3, matched: 3, importable: 3, errors: 0, unmatched: 0, unpaired: 0 });
  assert.deepEqual(plan.records.map(item => [item.id, item.sourceFileName, item.matchMethod]), [
    [3, '003-actual.png', 'leading-id'], [1, '001-a.png', 'exact'], [2, '002-002-b.png', 'duplicate-leading-id-prefix']
  ]);
  for (const imported of plan.records) {
    assert.deepEqual(imported.originalMetadata, originals[imported.recordIndex]);
    assert.equal(imported.prompts.en, originals[imported.recordIndex].prompt_en);
    assert.equal(imported.prompts.zh, originals[imported.recordIndex].prompt_cn);
    assert.equal(imported.type, 'photo');
    assert.equal(imported.typeOrigin, 'selected-default');
    assert.equal(imported.sha256, sha(PNG));
    assert.equal(imported.size, PNG.length);
    assert.equal(imported.imageValidation, 'decoded');
    assert.ok(Number.isSafeInteger(imported.dev) && Number.isSafeInteger(imported.ino));
  }
  assert.throws(() => { plan.records[0].originalMetadata.nested.unchanged[2].extra = false; }, TypeError);
  assert.deepEqual(await revalidateBatchImport(plan), { valid: true, manifestSha256: sha(data.bytes), matchedCount: 3 });
  assert.deepEqual(await fs.readFile(data.manifest), data.bytes);
  assert.deepEqual(await fs.readdir(data.images), ['001-a.png', '002-002-b.png', '003-actual.png']);
});

test('exact filename wins over extra same-id candidates; unresolved leading-id conflicts are rejected', async t => {
  const ambiguous = record(5, '005-absent.png'); delete ambiguous.image;
  const data = await fixture(t, [record(4, '004-a.png'), ambiguous],
    ['004-a.png', '004-004-a.png', '005-first.png', '005-second.png']);
  const plan = await data.prepare();
  assert.equal(plan.records.length, 1);
  assert.equal(plan.records[0].id, 4);
  assert.equal(plan.records[0].matchMethod, 'exact');
  assert.equal(plan.recordResults[1].status, 'error');
  assert.ok(plan.recordResults[1].issueCodes.includes('AMBIGUOUS_IMAGE'));
  assert.deepEqual(plan.unpaired.map(item => item.sourceFileName), ['004-004-a.png', '005-first.png', '005-second.png']);
});

test('explicit missing filename never falls back to a different same-ID image', async t => {
  const data = await fixture(t, [record(1, '001-a.png'), record(2, '002-b.png')], ['001-b.png', '002-002-b.png']);
  const plan = await data.prepare();
  assert.deepEqual(plan.records.map(item => item.id), [2]);
  assert.equal(plan.recordResults[0].status, 'unmatched');
  assert.ok(plan.recordResults[0].issueCodes.includes('IMAGE_NOT_FOUND'));
  assert.equal(plan.recordResults[0].sourceFileName, undefined);
  assert.equal(plan.records[0].matchMethod, 'duplicate-leading-id-prefix');
  assert.deepEqual(plan.unpaired.map(item => item.sourceFileName), ['001-b.png']);
});

test('partial safe import excludes all duplicate IDs, duplicate filenames, missing languages and unmatched rows', async t => {
  const noChinese = record(5, '005-missing-zh.png'); delete noChinese.prompt_cn;
  const rows = [record(1, '001-safe.png'), record(2, '002-a.png'), record('002', '002-b.png'),
    record(3, 'same.png'), record(4, 'same.png'), noChinese, record(6, '006-missing.png')];
  const data = await fixture(t, rows, ['001-safe.png', '002-a.png', '002-b.png', 'same.png', '005-missing-zh.png']);
  const plan = await data.prepare();
  assert.deepEqual(plan.records.map(item => item.id), [1]);
  assert.equal(plan.matchedCount, 2); // Missing Chinese was paired and validated, but is not importable.
  assert.equal(plan.counts.errors, 5);
  assert.equal(plan.counts.unmatched, 1);
  assert.ok(plan.recordResults[1].issueCodes.includes('DUPLICATE_ID'));
  assert.ok(plan.recordResults[2].issueCodes.includes('DUPLICATE_ID'));
  assert.ok(plan.recordResults[3].issueCodes.includes('DUPLICATE_IMAGE_NAME'));
  assert.ok(plan.recordResults[5].issueCodes.includes('MISSING_PROMPT_ZH'));
  assert.equal(plan.recordResults[6].status, 'unmatched');
  assert.equal(JSON.parse(plan.manifestBytes).length, 7);
  await revalidateBatchImport(plan);
});

test('prompt aliases remain literal and selected classification is separate from original metadata', async t => {
  const rows = [record(1, '001-a.png', { prompt_en: undefined, prompt_cn: undefined, prompt: 'alias original', prompt_zh: '别名中文', type: 'art' }),
    record(3, '003-b.png', { prompt_en: undefined, prompt: undefined, prompt_cn: undefined, prompts: { en: 'nested en', zh: '嵌套中文' } })];
  const data = await fixture(t, rows, ['001-a.png', '003-b.png']);
  const plan = await data.prepare({ type: 'art' });
  assert.deepEqual(plan.records[0].prompts, { en: 'alias original', zh: '别名中文' });
  assert.equal(plan.records[0].typeOrigin, 'source');
  assert.deepEqual(plan.records[1].prompts, { en: 'nested en', zh: '嵌套中文' });
  assert.equal(plan.records[1].type, 'art');
  assert.equal(plan.records[1].typeOrigin, 'selected-default');
  assert.equal(Object.hasOwn(plan.records[1].originalMetadata, 'type'), false);
});

test('invalid preferred prompt field does not silently fall back or fabricate a translation', async t => {
  const data = await fixture(t, [record(1, '001-a.png', { prompt_en: 42 }), record(2, '002-b.png', { prompt_cn: '' })], ['001-a.png', '002-b.png']);
  const plan = await data.prepare();
  assert.equal(plan.records.length, 0);
  assert.ok(plan.recordResults[0].issueCodes.includes('INVALID_PROMPT_EN'));
  assert.ok(plan.recordResults[1].issueCodes.includes('INVALID_PROMPT_ZH'));
  assert.equal(plan.matchedCount, 2);
});

test('record paths, conflicting filename aliases and ID-prefix mismatch are rejected individually', async t => {
  const data = await fixture(t, [record(1, '../outside.png'), record(2, '002-good.png', { filename: '002-different.png' }),
    record(3, '004-wrong.png'), record(5, 'https://user:pass@example.com/a.png')], ['002-good.png', '004-wrong.png']);
  const plan = await data.prepare();
  assert.equal(plan.records.length, 0);
  assert.ok(plan.recordResults[0].issueCodes.includes('INVALID_IMAGE_NAME'));
  assert.ok(plan.recordResults[1].issueCodes.includes('INVALID_IMAGE_NAME'));
  assert.ok(plan.recordResults[2].issueCodes.includes('ID_FILENAME_MISMATCH'));
  assert.ok(plan.recordResults[3].issueCodes.includes('INVALID_IMAGE_NAME'));
});

test('root and manifest symlinks are fatal; a matched image symlink is skipped without following it', async t => {
  const data = await fixture(t, [record(1, '001-a.png'), record(2, '002-b.png')], ['001-a.png', '002-b.png']);
  const linkedRoot = path.join(data.root, 'linked-images'); await fs.symlink(data.images, linkedRoot);
  await assert.rejects(data.prepare({ imageDirectory: linkedRoot }), errorCode('UNSAFE_PATH'));
  const linkedManifest = path.join(data.root, 'linked.json'); await fs.symlink(data.manifest, linkedManifest);
  await assert.rejects(data.prepare({ manifestPath: linkedManifest }), errorCode('UNSAFE_PATH'));
  await fs.unlink(path.join(data.images, '002-b.png'));
  await fs.symlink(path.join(data.images, '001-a.png'), path.join(data.images, '002-b.png'));
  const plan = await data.prepare();
  assert.deepEqual(plan.records.map(item => item.id), [1]);
  assert.ok(plan.recordResults[1].issueCodes.includes('SOURCE_SYMLINK'));
});

test('actual bytes and injected decoding reject invalid, mismatched and oversize images with partial import', async t => {
  const data = await fixture(t, [record(1, '001-safe.png'), record(2, '002-corrupt.png'), record(3, '003-bad.jpg'), record(4, '004-huge.png')],
    ['001-safe.png', '002-corrupt.png', '003-bad.jpg', '004-huge.png']);
  await fs.writeFile(path.join(data.images, '002-corrupt.png'), 'not a PNG');
  await fs.truncate(path.join(data.images, '004-huge.png'), CAPS.image + 1);
  const plan = await data.prepare({ validateImage: () => true });
  assert.deepEqual(plan.records.map(item => item.id), [1]);
  assert.ok(plan.recordResults[1].issueCodes.includes('INVALID_IMAGE'));
  assert.ok(plan.recordResults[2].issueCodes.includes('INVALID_IMAGE'));
  assert.ok(plan.recordResults[3].issueCodes.includes('IMAGE_TOO_LARGE'));
  const decodeRejected = await data.prepare({ validateImage: () => false });
  assert.equal(decodeRejected.records.length, 0);
  assert.ok(decodeRejected.recordResults[0].issueCodes.includes('INVALID_IMAGE'));
});

test('manifest parsing and record count/depth are bounded, with no trusted preflight input', async t => {
  const data = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  await fs.writeFile(data.manifest, JSON.stringify({ records: [record(1, '001-a.png')] }));
  await assert.rejects(data.prepare(), errorCode('INVALID_MANIFEST'));
  await fs.writeFile(data.manifest, Buffer.from([0xff]));
  await assert.rejects(data.prepare(), errorCode('INVALID_MANIFEST'));
  await fs.writeFile(data.manifest, JSON.stringify(Array.from({ length: 501 }, (_, index) => record(index + 1, `${index + 1}-x.png`))));
  await assert.rejects(data.prepare(), errorCode('MANIFEST_TOO_LARGE'));
  let nested = {}; for (let index = 0; index < 30; index++) nested = { nested };
  await fs.writeFile(data.manifest, JSON.stringify([record(1, '001-a.png', { nested })]));
  await assert.rejects(data.prepare(), errorCode('INVALID_MANIFEST'));
});

test('revalidation catches image mutation, manifest replacement and new ambiguous directory entries', async t => {
  const imageCase = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  const plan1 = await imageCase.prepare();
  await fs.writeFile(path.join(imageCase.images, '001-a.png'), Buffer.concat([PNG, Buffer.from('changed')]));
  await assert.rejects(revalidateBatchImport(plan1), errorCode('SOURCE_CHANGED'));
  const manifestCase = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  const plan2 = await manifestCase.prepare();
  await fs.rename(manifestCase.manifest, path.join(manifestCase.root, 'original.json'));
  await fs.writeFile(manifestCase.manifest, manifestCase.bytes);
  await assert.rejects(revalidateBatchImport(plan2), errorCode('SOURCE_CHANGED'));
  const namesCase = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  const plan3 = await namesCase.prepare();
  await fs.writeFile(path.join(namesCase.images, '001-second.png'), PNG);
  await assert.rejects(revalidateBatchImport(plan3), errorCode('SOURCE_CHANGED'));
});

test('revalidation catches same-name root replacement even when source bytes are identical', async t => {
  const data = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  const plan = await data.prepare();
  await fs.rename(data.images, path.join(data.root, 'old-images'));
  await fs.mkdir(data.images); await fs.writeFile(path.join(data.images, '001-a.png'), PNG);
  await assert.rejects(revalidateBatchImport(plan), errorCode('SOURCE_CHANGED'));
});

test('source mutation during the decoder callback aborts prepare instead of returning a stale plan', async t => {
  const data = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  await assert.rejects(data.prepare({ validateImage: async () => {
    await fs.writeFile(path.join(data.images, '001-a.png'), PNG); return true;
  } }), errorCode('SOURCE_CHANGED'));
});

test('private plan cannot be forged or altered through its mutable raw Buffer', async t => {
  const data = await fixture(t, [record(1, '001-a.png')], ['001-a.png']);
  const plan = await data.prepare();
  await assert.rejects(revalidateBatchImport({ ...plan }), errorCode('INVALID_PLAN'));
  plan.manifestBytes[0] ^= 1;
  await assert.rejects(revalidateBatchImport(plan), errorCode('INVALID_PLAN'));
  assert.deepEqual(await fs.readFile(data.manifest), data.bytes);
});
