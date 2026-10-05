'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createPreviewLibrary } = require('../preview-library.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'portrait-preview-test-'));
  const root = await fs.realpath(temporary);
  await fs.mkdir(path.join(root, '.portrait-studio'));
  await fs.mkdir(path.join(root, 'assets', 'images'), { recursive: true });
  const image = 'known.png', imageRel = `assets/images/${image}`;
  await fs.writeFile(path.join(root, imageRel), png);
  const index = { schemaVersion: 1, revision: 3, items: [{ id: 1, label: 'Known', type: 'photo', prompts: { en: 'Full English', zh: '完整中文' },
    image, imageRel, revision: 2, mime: 'image/png', size: png.length, sha256: digest(png) }] };
  const indexFile = path.join(root, '.portrait-studio', 'library.json');
  await fs.writeFile(indexFile, JSON.stringify(index));
  return { root, temporary, indexFile, index, service: await createPreviewLibrary({ root, expectedRoot: root }) };
}
async function request(service, url, { method = 'GET', headers = {} } = {}) {
  let status, responseHeaders, data;
  await service.middleware({ method, url, headers: { host: '127.0.0.1:5173', ...headers } }, {
    writeHead(value, values) { status = value; responseHeaders = values; },
    end(value) { data = Buffer.isBuffer(value) ? value : Buffer.from(value); }
  }, () => { status = 404; });
  return { status, headers: responseHeaders, bytes: data, json: () => JSON.parse(data.toString()) };
}
test('readonly preview returns complete metadata and verified image without changing files', async () => {
  const f = await fixture();
  try {
    const beforeIndex = await fs.readFile(f.indexFile);
    const beforeNames = await fs.readdir(path.join(f.root, '.portrait-studio'));
    const list = await request(f.service, '/__preview/api/library');
    assert.equal(list.status, 200); assert.equal(list.json().data.writable, false);
    assert.equal(list.json().data.backend, 'local'); assert.equal(list.json().data.remote, false);
    assert.equal(list.json().data.items[0].mime, f.index.items[0].mime);
    assert.equal(list.json().data.items[0].size, f.index.items[0].size);
    assert.equal(list.json().data.items[0].sha256, f.index.items[0].sha256);
    assert.deepEqual(list.json().data.items[0].prompts, f.index.items[0].prompts);
    assert.equal(list.json().data.items[0].image_url, '/__preview/api/images/1?revision=2');
    const detail = await request(f.service, '/__preview/api/portraits/1');
    assert.equal(detail.json().data.revision, 3);
    const image = await request(f.service, '/__preview/api/images/1?revision=2');
    assert.equal(image.status, 200); assert.deepEqual(image.bytes, png);
    assert.equal(image.headers['Content-Type'], 'image/png'); assert.equal(image.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(image.headers['Access-Control-Allow-Origin'], undefined);
    assert.deepEqual(await fs.readFile(f.indexFile), beforeIndex);
    assert.deepEqual(await fs.readdir(path.join(f.root, '.portrait-studio')), beforeNames);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'assets/images/known.png')), png);
  } finally { await fs.rm(f.temporary, { recursive: true }); }
});
test('preview rejects hostile host/origin, cross-site requests, write methods and arbitrary paths/queries', async () => {
  const f = await fixture();
  try {
    for (const headers of [{ host: 'localhost:5173' }, { host: '127.0.0.1:5174' }, { origin: 'https://example.com' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await request(f.service, '/__preview/api/library', { headers })).status, 403);
    }
    assert.equal((await request(f.service, '/__preview/api/library', { method: 'POST' })).status, 405);
    for (const url of ['/__preview/api/library?root=/etc', '/__preview/api/images/1?revision=2&path=/etc/passwd', '/__preview/api/images/1?revision=2&revision=2',
      '/__preview/api/images/%2e%2e%2fpasswd?revision=2', '/__preview/api/images/1/../../passwd', '/__preview/api/images/1?revision=1', '/__preview/api/portraits/1?x=1']) {
      const response = await request(f.service, url);
      assert.equal(response.status, 400, url); assert.equal(response.json().ok, false);
      assert.equal(response.bytes.toString().includes(f.root), false);
    }
  } finally { await fs.rm(f.temporary, { recursive: true }); }
});
test('preview rejects symlink or replaced directories, corrupt bytes and malformed index', async () => {
  const f = await fixture();
  try {
    const imageFile = path.join(f.root, 'assets/images/known.png');
    await fs.writeFile(imageFile, Buffer.from('corrupt'));
    assert.equal((await request(f.service, '/__preview/api/images/1?revision=2')).json().error.code, 'CONFLICT');
    await fs.unlink(imageFile);
    await fs.symlink(f.indexFile, imageFile);
    assert.equal((await request(f.service, '/__preview/api/images/1?revision=2')).json().error.code, 'UNSAFE_PATH');
    await fs.writeFile(f.indexFile, JSON.stringify({ ...f.index, items: [{ ...f.index.items[0], imageRel: '../outside.png' }] }));
    assert.equal((await request(f.service, '/__preview/api/library')).json().error.code, 'INVALID_DATA');
    await fs.writeFile(f.indexFile, JSON.stringify(f.index));
    const meta = path.join(f.root, '.portrait-studio');
    await fs.rename(meta, `${meta}-old`); await fs.mkdir(meta);
    await fs.writeFile(f.indexFile, JSON.stringify(f.index));
    assert.equal((await request(f.service, '/__preview/api/library')).json().error.code, 'CONFLICT');
  } finally { await fs.rm(f.temporary, { recursive: true }); }
});

test('preview session supports in-memory batch delete without touching disk', async () => {
  const f = await fixture();
  try {
    const beforeIndex = await fs.readFile(f.indexFile);
    const del = await request(f.service, '/__preview/api/portraits/1/delete', { method: 'POST' });
    assert.equal(del.status, 200);
    assert.equal(del.json().ok, true);
    assert.equal(del.json().data.items.length, 0);
    assert.equal(del.json().data.revision, 4);
    const list = await request(f.service, '/__preview/api/library');
    assert.equal(list.json().data.items.length, 0);
    assert.equal(list.json().data.revision, 4);
    assert.equal((await request(f.service, '/__preview/api/portraits/1')).status, 404);
    const again = await request(f.service, '/__preview/api/portraits/1/delete', { method: 'POST' });
    assert.equal(again.status, 200);
    assert.equal(again.json().data.revision, 4);
    assert.deepEqual(await fs.readFile(f.indexFile), beforeIndex);
  } finally {
    await fs.rm(f.temporary, { recursive: true });
  }
});
