'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRemotePreview, remotePreviewPlugin } = require('../remote-preview.cjs');
const { LIMITS } = require('../remote-client.cjs');

// All remote responses here are bounded in-memory fetch fixtures. These tests
// never open a listener, read a gallery, use SSH or modify a server.
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const authorization = 'Basic existing-test-credential';
const item = { id: 51, label: 'Original image', type: 'photo', revision: 2, prompts: { en: ' Full original English.\n All constraints retained. ', zh: ' 完整中文提示词。\n 保留全部细节。 ' },
  image: '051.png', imageRel: 'assets/images/051.png', image_url: 'https://untrusted.example/private',
  mime: 'image/png', size: imageBytes.length, sha256: createHash('sha256').update(imageBytes).digest('hex'),
  sourceMetadata: { id: 1, arbitraryOriginalField: ['kept', { full: true }], prompt: 'Original source prompt' },
  sourceImport: { sourceId: 1, sourceRelativePath: 'generated_portraits/001.png', matchMethod: 'exact-relative-path' } };
const snapshot = { configured: true, writable: true, revision: 7, root: '/private/server/gallery', items: [item],
  authorization, connection: { endpoint: 'https://untrusted.example/', authorization }, internalPath: '/private/server/gallery' };
function json(data, status = 200) { return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } }); }
function fixture(reply, options = {}) {
  const calls = [];
  const service = createRemotePreview({ baseURL: 'https://server.example/portrait-studio/', authorization, ...options,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (reply) return reply(url, init);
      if (url.endsWith('/v1/library')) return json(snapshot);
      if (url.endsWith('/v1/portraits/51')) return json({ revision: 7, item });
      if (url.endsWith('/v1/images/51?revision=2')) return new Response(imageBytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(imageBytes.length) } });
      throw new Error('Unexpected fixture route');
    } });
  return { service, calls };
}
async function request(service, url, { method = 'GET', headers = {} } = {}) {
  let status, responseHeaders, bytes;
  await service.middleware({ method, url, headers: { host: '127.0.0.1:5173', ...headers } }, {
    writeHead(value, values) { status = value; responseHeaders = values; },
    end(value) { bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); }
  }, () => { status = 404; bytes = Buffer.alloc(0); });
  return { status, headers: responseHeaders, bytes, json: () => JSON.parse(bytes.toString()) };
}

test('remote preview preserves complete prompts and source fields while exposing only readonly fixed image URLs', async () => {
  const f = fixture();
  const result = await request(f.service, '/__preview/api/library');
  assert.equal(result.status, 200);
  const data = result.json().data;
  assert.equal(data.configured, true); assert.equal(data.remote, true); assert.equal(data.writable, false);
  assert.equal(data.root, 'Server library'); assert.equal(data.revision, 7);
  assert.deepEqual(data.items[0].prompts, item.prompts);
  assert.deepEqual(data.items[0].sourceMetadata, item.sourceMetadata);
  assert.deepEqual(data.items[0].sourceImport, item.sourceImport);
  assert.equal(data.items[0].image_url, '/__preview/api/images/51?revision=2');
  for (const value of [authorization, '/private/server/gallery', 'https://untrusted.example']) assert.equal(result.bytes.toString().includes(value), false);
  assert.equal(Object.hasOwn(data, 'connection'), false);
  assert.equal(f.calls[0].url, 'https://server.example/portrait-studio/v1/library');
  assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.headers.Authorization, authorization);
  assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
});

test('detail and images use only canonical fixed remote IDs and verify exact returned image bytes', async () => {
  const f = fixture();
  const detail = await request(f.service, '/__preview/api/portraits/51');
  assert.equal(detail.status, 200); assert.equal(detail.json().data.item.id, 51);
  assert.equal(detail.json().data.item.image_url, '/__preview/api/images/51?revision=2');
  const image = await request(f.service, '/__preview/api/images/51?revision=2');
  assert.equal(image.status, 200); assert.deepEqual(image.bytes, imageBytes);
  assert.equal(image.headers['Content-Type'], 'image/png'); assert.equal(image.headers['Content-Length'], imageBytes.length);
  assert.deepEqual(f.calls.map(call => [call.init.method, call.url]), [
    ['GET', 'https://server.example/portrait-studio/v1/portraits/51'],
    ['GET', 'https://server.example/portrait-studio/v1/portraits/51'],
    ['GET', 'https://server.example/portrait-studio/v1/images/51?revision=2']
  ]);
});

test('host, origin and cross-site boundaries reject requests before remote contact', async () => {
  const f = fixture();
  for (const headers of [{ host: 'localhost:5173' }, { host: '127.0.0.1:5174' }, { host: '127.0.0.1:5173.evil.example' },
    { origin: 'https://evil.example' }, { origin: 'null' }, { origin: ['http://127.0.0.1:5173'] }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await request(f.service, '/__preview/api/library', { headers });
    assert.equal(result.status, 403); assert.equal(result.json().error.code, 'FORBIDDEN');
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await request(f.service, '/__preview/api/library', { headers: { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('write methods, noncanonical routes and arbitrary queries cannot reach any remote route', async () => {
  const f = fixture();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const result = await request(f.service, '/__preview/api/library', { method });
    assert.equal(result.status, 405);
  }
  for (const url of ['/__preview/api/library?root=/etc', '/__preview/api/portraits/051', '/__preview/api/portraits/0',
    '/__preview/api/portraits/1000000', '/__preview/api/portraits/51?x=1', '/__preview/api/images/51',
    '/__preview/api/images/51?revision=02', '/__preview/api/images/51?revision=0', '/__preview/api/images/51?revision=9007199254740992',
    '/__preview/api/images/51?revision=2&revision=2', '/__preview/api/images/51?revision=2&path=/etc/passwd',
    '/__preview/api/images/51?revision=%32', '/__preview/api/images/51?revision=2#fragment', '/__preview/api/images/%35%31?revision=2',
    '/__preview/api/images/51/../../library', '/__preview/api/images/51\\private?revision=2', '/__preview/api/https://evil.example/']) {
    const result = await request(f.service, url);
    assert.equal(result.status, 400, url); assert.equal(result.json().error.code, 'INVALID_INPUT', url);
  }
  assert.equal(f.calls.length, 0);
});

test('stale image revision fails before any binary fetch', async () => {
  const f = fixture();
  const result = await request(f.service, '/__preview/api/images/51?revision=1');
  assert.equal(result.status, 409); assert.equal(result.json().error.code, 'CONFLICT');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.endsWith('/v1/portraits/51'), true);
});

test('corrupt image bytes, incorrect MIME and oversized image responses are never served', async () => {
  for (const corrupt of [
    () => new Response(Buffer.from(imageBytes).fill(9, imageBytes.length - 1), { headers: { 'Content-Type': 'image/png' } }),
    () => new Response(imageBytes, { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response(imageBytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(LIMITS.image + 1) } })
  ]) {
    const f = fixture(url => url.includes('/v1/portraits/') ? json({ revision: 7, item }) : corrupt());
    const result = await request(f.service, '/__preview/api/images/51?revision=2');
    assert.equal([409, 502].includes(result.status), true);
    assert.equal(result.json().ok, false);
    assert.equal(result.headers['Content-Type'], 'application/json; charset=utf-8');
  }
});

test('remote transport failures return sanitized errors and no local-library fallback', async () => {
  const secret = '/private/server/password-and-private-path';
  const f = fixture(() => { throw new Error(secret); });
  const result = await request(f.service, '/__preview/api/library');
  assert.equal(result.status, 503); assert.equal(result.json().error.code, 'REMOTE_UNAVAILABLE');
  assert.equal(result.bytes.toString().includes(secret), false); assert.equal(result.bytes.toString().includes(authorization), false);
  assert.equal(f.calls.length, 1);
});

test('preview preserves distinct authentication, missing-route and unavailable-service statuses', async () => {
  for (const [remoteStatus, expectedStatus, code] of [[401, 401, 'REMOTE_AUTH_REQUIRED'], [403, 403, 'REMOTE_FORBIDDEN'],
    [404, 404, 'REMOTE_ROUTE_MISSING'], [502, 503, 'REMOTE_SERVICE_UNAVAILABLE'],
    [503, 503, 'REMOTE_SERVICE_UNAVAILABLE'], [504, 503, 'REMOTE_SERVICE_UNAVAILABLE']]) {
    const f = fixture(() => new Response('Private proxy diagnostic must remain private', { status: remoteStatus, headers: { 'Content-Type': 'text/html' } }));
    const result = await request(f.service, '/__preview/api/library');
    assert.equal(result.status, expectedStatus);
    assert.equal(result.json().error.code, code);
    assert.equal(result.bytes.toString().includes('Private proxy diagnostic'), false);
    assert.equal(f.calls.length, 1);
  }
});

test('unconfigured or unsafe remote endpoint fails explicitly without constructing a local gallery', () => {
  for (const baseURL of [null, '', 'file:///private/gallery', 'http://18.180.65.241:4137/', 'https://user:password@server.example/',
    'https://server.example/?path=/private/gallery']) {
    assert.throws(() => createRemotePreview({ baseURL }), error => error.code === 'REMOTE_NOT_CONFIGURED');
  }
  assert.doesNotThrow(() => createRemotePreview({ baseURL: 'http://127.0.0.1:4137/' }));
  assert.throws(() => createRemotePreview({ baseURL: 'http://127.0.0.1:4137/', allowLoopback: false }), error => error.code === 'REMOTE_NOT_CONFIGURED');
});

test('Vite plugin preserves global HTTP and websocket-upgrade boundaries even with no remote configuration', async () => {
  let middleware, upgrade;
  remotePreviewPlugin({ baseURL: null }).configureServer({
    middlewares: { use(value) { middleware = value; } },
    httpServer: { prependListener(name, value) { assert.equal(name, 'upgrade'); upgrade = value; } }
  });
  const service = { middleware };
  const missing = await request(service, '/__preview/api/library');
  assert.equal(missing.status, 503); assert.equal(missing.json().error.code, 'REMOTE_NOT_CONFIGURED');
  assert.equal((await request(service, '/src/main.jsx', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(service, '/src/main.jsx', { method: 'POST' })).status, 405);
  assert.equal((await request(service, '/__open-in-editor?file=/etc/passwd')).status, 403);
  assert.equal((await request(service, '/src/main.jsx')).status, 404);
  let destroyed = 0;
  const socket = { destroy() { destroyed += 1; } };
  upgrade({ headers: { host: '127.0.0.1:5173', origin: 'https://evil.example' } }, socket);
  upgrade({ headers: { host: 'evil.example', origin: 'http://127.0.0.1:5173' } }, socket);
  upgrade({ headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' } }, socket);
  assert.equal(destroyed, 2);
});
