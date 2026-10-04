'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const { prepareDirectoryUpload, revalidateDirectoryUpload, CAPS } = require('../remote-source.cjs');

function image(color = 17) { const png = new PNG({ width: 2, height: 2 }); for (let i = 0; i < png.data.length; i += 4) png.data.set([color, 27, 99, 255], i); return PNG.sync.write(png); }
async function fixture(t, manifest = Buffer.from('{"images":[]}\n')) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-upload-source-')));
  const directory = path.join(base, 'source'); await fs.mkdir(path.join(directory, 'images'), { recursive: true });
  const files = { 'images/001-first.png': image(31), 'images/arbitrary-name.png': image(32), 'manifest.json': manifest, 'notes.txt': Buffer.from('Source must remain unchanged.\n') };
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(directory, name), bytes);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, directory, files, prepare: () => prepareDirectoryUpload({ directory, manifestRelativePath: 'manifest.json' }) };
}

test('upload preparation preserves raw JSON and every image without judging IDs, prompts or pairing', async t => {
  const raw = Buffer.from(' {"images":[{"id":1,"image":"missing.png","prompt":" English only "},{"id":1,"label":null}],"raw":{"source":true}}\n');
  const f = await fixture(t, raw), plan = await f.prepare();
  assert.deepEqual(plan.manifestBytes, raw); assert.deepEqual(plan.images.map(file => file.relativePath), ['images/001-first.png', 'images/arbitrary-name.png']);
  for (const file of plan.images) assert.deepEqual(file.bytes, f.files[file.relativePath]);
  assert.equal(plan.totalBytes, plan.images.reduce((sum, file) => sum + file.bytes.length, 0));
  assert.equal(Object.hasOwn(plan, 'records'), false); assert.equal(Object.hasOwn(plan, 'prompts'), false);
  assert.equal((await revalidateDirectoryUpload(plan)).imageCount, 2);
  for (const [name, bytes] of Object.entries(f.files)) assert.deepEqual(await fs.readFile(path.join(f.directory, name)), bytes);
});

test('malformed JSON remains raw transport data for authoritative Go validation', async t => {
  const f = await fixture(t, Buffer.from('{not valid JSON\n')), plan = await f.prepare();
  assert.deepEqual(plan.manifestBytes, f.files['manifest.json']); await revalidateDirectoryUpload(plan);
});

test('forged plans or modified in-memory manifest/image bytes cannot pass revalidation', async t => {
  const f = await fixture(t), plan = await f.prepare();
  await assert.rejects(revalidateDirectoryUpload({ ...plan }), error => error.code === 'INVALID_PLAN');
  plan.images[0].bytes[20] ^= 1;
  await assert.rejects(revalidateDirectoryUpload(plan), error => error.code === 'INVALID_PLAN');
  const next = await f.prepare(); next.manifestBytes[0] ^= 1;
  await assert.rejects(revalidateDirectoryUpload(next), error => error.code === 'INVALID_PLAN');
});

test('manifest, matched or unpaired image, other entry and directory mutations invalidate the upload snapshot', async t => {
  for (const name of ['manifest.json', 'images/001-first.png', 'images/arbitrary-name.png', 'notes.txt']) {
    const f = await fixture(t), plan = await f.prepare();
    await fs.writeFile(path.join(f.directory, name), name.endsWith('.png') ? image(107) : Buffer.from('modified\n'));
    await assert.rejects(revalidateDirectoryUpload(plan), error => error.code === 'SOURCE_CHANGED');
  }
  const f = await fixture(t), plan = await f.prepare(); await fs.writeFile(path.join(f.directory, 'added.txt'), 'new');
  await assert.rejects(revalidateDirectoryUpload(plan), error => error.code === 'SOURCE_CHANGED');
});

test('symlink images, manifests, ancestors and unrelated entries are never followed', async t => {
  for (const name of ['images/001-first.png', 'manifest.json', 'notes.txt']) {
    const f = await fixture(t), target = path.join(f.base, 'outside'); await fs.writeFile(target, image(11));
    await fs.unlink(path.join(f.directory, name)); await fs.symlink(target, path.join(f.directory, name));
    await assert.rejects(f.prepare(), error => error.code === 'UNSAFE_PATH'); assert.deepEqual(await fs.readFile(target), image(11));
  }
  const f = await fixture(t), link = path.join(f.base, 'source-alias'); await fs.symlink(f.directory, link);
  await assert.rejects(prepareDirectoryUpload({ directory: link, manifestRelativePath: 'manifest.json' }), error => error.code === 'UNSAFE_PATH');
});

test('unsafe manifest paths, missing candidates, excess depth, count and individual byte limits fail closed', async t => {
  const f = await fixture(t);
  for (const manifestRelativePath of ['/etc/passwd', '../manifest.json', 'images/../../manifest.json', 'images\\manifest.json', 'images/:bad.json']) await assert.rejects(prepareDirectoryUpload({ directory: f.directory, manifestRelativePath }), error => error.code === 'INVALID_MANIFEST');
  await assert.rejects(prepareDirectoryUpload({ directory: f.directory, manifestRelativePath: 'missing.json' }), error => error.code === 'INVALID_MANIFEST');
  await fs.mkdir(path.join(f.directory, 'a/b/c/d'), { recursive: true }); await assert.rejects(f.prepare(), error => error.code === 'DIRECTORY_TOO_DEEP');
  const count = await fixture(t); for (let start = 0; start < CAPS.entries; start += 250) await Promise.all(Array.from({ length: Math.min(250, CAPS.entries - start) }, (_, index) => fs.writeFile(path.join(count.directory, `entry-${start + index}.txt`), '')));
  await assert.rejects(count.prepare(), error => error.code === 'DIRECTORY_TOO_LARGE');
  const oversized = await fixture(t); const manifest = await fs.open(path.join(oversized.directory, 'manifest.json'), 'r+'); await manifest.truncate(CAPS.manifest + 1); await manifest.close();
  await assert.rejects(oversized.prepare(), error => error.code === 'MANIFEST_TOO_LARGE');
  const hugeImage = await fixture(t); const handle = await fs.open(path.join(hugeImage.directory, 'images/001-first.png'), 'r+'); await handle.truncate(CAPS.image + 1); await handle.close();
  await assert.rejects(hugeImage.prepare(), error => error.code === 'IMAGE_TOO_LARGE');
});
