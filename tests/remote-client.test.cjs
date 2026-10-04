'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { PNG } = require('pngjs');
const { RemoteClient, RemoteError, validateEndpoint, validateItem, validateSnapshot, safeRelativePath, LIMITS } = require('../remote-client.cjs');

// These tests exercise the real client using bounded in-memory HTTP responses.
// No server, SSH connection, native application or real library is touched.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const previewID = '00000000-0000-4000-8000-000000000001';
function png() {
  const value = new PNG({ width: 2, height: 3 });
  for (let index = 0; index < value.data.length; index += 4) value.data.set([41, 67, 113, 255], index);
  return PNG.sync.write(value);
}
const imageBytes = png();
function item(overrides = {}) {
  return { id: 51, revision: 1, label: '完整原始字段', type: 'photo',
    prompts: { en: ' Original English.\n Preserve every character. ', zh: ' 完整中文译文。\n 保留全部空格。 ' },
    mime: 'image/png', size: imageBytes.length, sha256: digest(imageBytes), ...overrides };
}
function snapshot(overrides = {}) { return { configured: true, root: 'Remote portrait library', writable: true, revision: 3, items: [item()], ...overrides }; }
function json(data, options = {}) { return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, ...options }); }
function fixture(reply = () => json(snapshot()), options = {}) {
  const calls = [];
  const client = new RemoteClient({ baseURL: 'https://portrait.example/portrait-studio/', ...options,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return reply(url, init); } });
  return { client, calls };
}
function rejectsCode(promise, code) { return assert.rejects(promise, error => error instanceof RemoteError && error.code === code); }
function throwsCode(action, code) { return assert.throws(action, error => error instanceof RemoteError && error.code === code); }
function preview(overrides = {}) { return { previewId: previewID, revision: 3, items: [], issues: [], unpaired: [], canImport: true, ...overrides }; }
function batch(overrides = {}) { return { manifestRelativePath: 'manifest.json', manifestBytes: Buffer.from(' {"images":[]}\n'), type: 'photo', images: [], ...overrides }; }
const fakeSessionToken = Buffer.alloc(32, 0x46).toString('base64url');
const platformCredentials = () => ({ username: 'admin', password: '  FAKE-only:密码🧪-preserved  ' });
const loginReply = (overrides = {}) => ({ sessionToken: fakeSessionToken, username: 'admin', expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides });
function authError(code) { return new Response(JSON.stringify({ ok: false, error: { code, message: '/private/credential/internal-details' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }); }

test('endpoint configuration permits HTTPS and explicit loopback development while rejecting ambiguous paths and credentials', () => {
  assert.equal(validateEndpoint('https://portrait.example/portrait-studio/').endpoint, 'https://portrait.example/portrait-studio/');
  assert.equal(validateEndpoint('https://portrait.example').transport, 'https');
  assert.equal(validateEndpoint('http://127.0.0.1:4137', true).transport, 'loopback-development');
  assert.equal(validateEndpoint('http://[::1]:4137/', true).transport, 'loopback-development');
  for (const endpoint of ['http://127.0.0.1:4137', 'http://portrait.example/', 'http://localhost:4137/', 'file:///tmp/index.html',
    'https://user:password@portrait.example/', 'https://portrait.example/?token=secret', 'https://portrait.example/#fragment',
    'https://portrait.example/portrait-studio', 'https://portrait.example/a/../portrait-studio/', 'https://portrait.example/a/%2e%2e/',
    'https://portrait.example/portrait%2Fstudio/', 'https://portrait.example//portrait/', 'https://portrait.example/a\\b/',
    'https://portrait.example/ portrait/']) {
    throwsCode(() => validateEndpoint(endpoint), 'REMOTE_NOT_CONFIGURED');
  }
  throwsCode(() => validateEndpoint('http://18.180.65.241:4137/', true), 'REMOTE_NOT_CONFIGURED');
});

test('all fixed API requests retain the configured HTTPS prefix and authorization remains private', async () => {
  const authorization = 'Basic test-only-existing-credential';
  const f = fixture(() => json(snapshot()), { authorization });
  await f.client.list();
  assert.equal(f.calls[0].url, 'https://portrait.example/portrait-studio/v1/library');
  assert.equal(f.calls[0].init.headers.Authorization, authorization);
  assert.equal(f.calls[0].init.redirect, 'error');
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  assert.equal(f.client.connection.encrypted, true);
  assert.equal(f.client.connection.authorizationProvided, true);
  assert.equal(Object.hasOwn(f.client.connection, 'protected'), false);
  assert.equal(JSON.stringify(f.client).includes(authorization), false);
  for (const invalid of ['', ' ', 'Basic secret\r\nX-Injected: true', 'Basic secret\0']) {
    throwsCode(() => fixture(undefined, { authorization: invalid }), 'REMOTE_NOT_CONFIGURED');
  }
});

test('Basic authentication clones a pinned HTTPS client and preserves exact UTF-8 credentials without changing the previous client', async () => {
  const previousAuthorization = 'Basic previous-test-only-header';
  const f = fixture(() => json(snapshot()), { authorization: previousAuthorization });
  const credentials = { username: '测试账号', password: '  exact:密码🧪  ' };
  const expected = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64');
  const candidate = f.client.withBasicCredentials(credentials);
  assert.notEqual(candidate, f.client);
  assert.equal(f.calls.length, 0, 'credential preparation sends no request');
  assert.equal(candidate.connection.endpoint, f.client.connection.endpoint);
  assert.equal(Object.isFrozen(candidate.connection), true);
  await candidate.list();
  await f.client.list();
  assert.deepEqual(f.calls.map(call => call.url), [
    'https://portrait.example/portrait-studio/v1/library',
    'https://portrait.example/portrait-studio/v1/library',
  ]);
  assert.equal(f.calls[0].init.headers.Authorization, expected);
  assert.equal(f.calls[1].init.headers.Authorization, previousAuthorization);
  assert.deepEqual(credentials, { username: '测试账号', password: '  exact:密码🧪  ' });
  for (const secret of [credentials.username, credentials.password, expected, previousAuthorization]) {
    assert.equal(JSON.stringify(candidate).includes(secret), false);
  }
});

test('Basic credential input rejects unknown fields, malformed usernames and controls before any request', () => {
  const f = fixture();
  for (const value of [null, [], {}, { username: 'user', password: 'secret', endpoint: 'https://other.example/' },
    { username: '', password: 'secret' }, { username: 'user:name', password: 'secret' }, { username: 'user\nname', password: 'secret' },
    { username: 'user', password: '' }, { username: 'user', password: 'secret\0' }, { username: 'user', password: 'secret\r' },
    { username: 'u'.repeat(257), password: 'secret' }, { username: 'user', password: 'x'.repeat(8193) }]) {
    throwsCode(() => f.client.withBasicCredentials(value), 'INVALID_INPUT');
  }
  assert.equal(f.calls.length, 0);
});

test('Basic credential encoding is bounded and never truncates an oversized ASCII or multibyte password', () => {
  const f = fixture();
  for (const password of ['x'.repeat(8192), '秘密'.repeat(2000)]) {
    throwsCode(() => f.client.withBasicCredentials({ username: 'test-user', password }), 'INVALID_INPUT');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.client.connection.authorizationProvided, false);
});

test('Basic credentials cannot be attached to an explicit HTTP development connection', () => {
  const f = fixture(undefined, { baseURL: 'http://127.0.0.1:4137/', allowLoopback: true });
  throwsCode(() => f.client.withBasicCredentials({ username: 'test-user', password: 'test-only-password' }), 'REMOTE_NOT_CONFIGURED');
  assert.equal(f.calls.length, 0);
});

test('network failures and redirect responses do not trigger retries or fallback requests', async () => {
  const failed = fixture(() => { throw new TypeError('Test-only redirect/network failure'); });
  await rejectsCode(failed.client.list(), 'REMOTE_UNAVAILABLE');
  assert.equal(failed.calls.length, 1);
  const redirected = fixture(() => new Response(null, { status: 302, headers: { Location: 'https://other.example/private' } }));
  await rejectsCode(redirected.client.list(), 'REMOTE_INVALID_RESPONSE');
  assert.equal(redirected.calls.length, 1);
});

test('request deadlines abort a pending transport and return a bounded public error', async () => {
  const originalSetTimeout = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (action, milliseconds, ...args) => { deadlines.push(milliseconds); return originalSetTimeout(action, 20, ...args); };
  try {
    const f = fixture((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Test-only abort', 'AbortError')), { once: true })));
    await rejectsCode(f.client.list(), 'REMOTE_TIMEOUT');
    assert.deepEqual(deadlines, [12000]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.signal.aborted, true);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('cancel uses a short aborting deadline so an unavailable server does not hold application shutdown for two minutes', async () => {
  const originalSetTimeout = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (action, milliseconds, ...args) => {
    deadlines.push(milliseconds);
    return originalSetTimeout(action, 20, ...args);
  };
  try {
    const f = fixture((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Test-only cancel deadline', 'AbortError')), { once: true })));
    await rejectsCode(f.client.cancel(previewID), 'REMOTE_TIMEOUT');
    assert.deepEqual(deadlines, [5000]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.signal.aborted, true);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('malformed content types, JSON, UTF-8, envelopes and untrusted error codes fail closed', async () => {
  const responses = [
    () => new Response('<html>upstream</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(Buffer.from([0xff, 0xfe]), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify({ ok: 'true', data: snapshot() }), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify({ ok: true, data: [] }), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify({ ok: false, error: { code: '../secret', message: '/private/server/token' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const response of responses) await rejectsCode(fixture(response).client.list(), 'REMOTE_INVALID_RESPONSE');
  const f = fixture(() => new Response(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: '/private/server/token' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(f.client.list(), error => error.code === 'CONFLICT' && error.message === 'CONFLICT' && !error.message.includes('/private'));
});

test('an existing HTTPS authentication challenge has a stable error for either HTML or JSON without leaking the response', async () => {
  for (const response of [
    () => new Response('<html>existing restricted server challenge</html>', { status: 401, headers: { 'Content-Type': 'text/html', 'WWW-Authenticate': 'Basic realm="restricted"' } }),
    () => new Response(JSON.stringify({ error: 'Authentication needed', privatePath: '/private/server/credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const f = fixture(response);
    await assert.rejects(f.client.list(), error => error instanceof RemoteError && error.code === 'REMOTE_AUTH_REQUIRED' && error.message === 'REMOTE_AUTH_REQUIRED');
    assert.equal(f.calls.length, 1);
  }
});

test('authentication, permission, missing library routes and gateway failures are classified before any HTML or JSON body is read', async () => {
  for (const [status, code] of [[401, 'REMOTE_AUTH_REQUIRED'], [403, 'REMOTE_FORBIDDEN'], [404, 'REMOTE_ROUTE_MISSING'],
    [502, 'REMOTE_SERVICE_UNAVAILABLE'], [503, 'REMOTE_SERVICE_UNAVAILABLE'], [504, 'REMOTE_SERVICE_UNAVAILABLE']]) {
    let canceled = 0, read = 0;
    const f = fixture(() => ({ status, ok: false, headers: new Headers({ 'Content-Type': 'text/html', 'Content-Length': String(LIMITS.json + 1) }),
      body: { async cancel() { canceled++; }, getReader() { read++; throw new Error('Private gateway credentials and upstream details'); } } }));
    await assert.rejects(f.client.list(), error => error instanceof RemoteError && error.code === code && error.message === code && !error.cause);
    assert.equal(canceled, 1);
    assert.equal(read, 0, 'error pages never enter the body parser');
    assert.equal(f.calls.length, 1, 'no retries or fallback routes');
  }
});

test('only the fixed library route receives route-missing classification while portrait and batch 404 errors retain business codes', async () => {
  const library = fixture(() => new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'private upstream route' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }));
  await rejectsCode(library.client.list(), 'REMOTE_ROUTE_MISSING');
  const portrait = fixture(() => new Response(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'private original file' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }));
  await rejectsCode(portrait.client.get(51), 'NOT_FOUND');
  await rejectsCode(portrait.client.image(item()), 'NOT_FOUND');
  const absentBatch = fixture(() => new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_BATCH_SELECTION', message: 'private lease' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }));
  await rejectsCode(absentBatch.client.commit(previewID, { expectedVersion: 3, confirmed: true }), 'INVALID_BATCH_SELECTION');
  const unrelatedHTML = fixture(() => new Response('<html>private missing portrait</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }));
  await rejectsCode(unrelatedHTML.client.get(51), 'REMOTE_INVALID_RESPONSE');
});

test('image gateway statuses and cancellation failures expose only the stable public status code', async () => {
  const f = fixture(() => ({ status: 503, ok: false, headers: new Headers({ 'Content-Type': 'text/html' }),
    body: { async cancel() { throw new Error('Private cancellation details'); }, getReader() { throw new Error('Must not read gateway body'); } } }));
  await rejectsCode(f.client.image(item()), 'REMOTE_SERVICE_UNAVAILABLE');
  assert.equal(f.calls.length, 1);
  const forbidden = fixture(() => new Response(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: '/private/token' } }),
    { status: 403, headers: { 'Content-Type': 'application/json' } }));
  await rejectsCode(forbidden.client.list(), 'REMOTE_FORBIDDEN');
});

test('network, TLS and external abort failures remain different from the client deadline and never expose transport details', async () => {
  for (const failure of [new TypeError('private-network-address'), new Error('private-certificate-error'), new DOMException('private-external-abort', 'AbortError')]) {
    const f = fixture(() => { throw failure; });
    await assert.rejects(f.client.list(), error => error.code === 'REMOTE_UNAVAILABLE' && error.message === 'REMOTE_UNAVAILABLE' && !error.cause);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.signal.aborted, false);
  }
});

test('the twelve-second probe deadline also aborts a stalled response body without returning private stream details', async () => {
  const originalSetTimeout = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (action, milliseconds, ...args) => { deadlines.push(milliseconds); return originalSetTimeout(action, 20, ...args); };
  try {
    let released = false;
    const f = fixture((_url, init) => ({ status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader() { return {
        read: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private-stream-abort')), { once: true })),
        releaseLock() { released = true; },
      }; } } }));
    await rejectsCode(f.client.list(), 'REMOTE_TIMEOUT');
    assert.deepEqual(deadlines, [12000]);
    assert.equal(released, true);
    assert.equal(f.calls.length, 1);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('short library probes preserve the existing large-upload deadline', async () => {
  const originalSetTimeout = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (action, milliseconds, ...args) => { deadlines.push(milliseconds); return originalSetTimeout(action, milliseconds, ...args); };
  try {
    const f = fixture(url => json(url.endsWith('/v1/library') ? snapshot() : preview()));
    await f.client.list();
    await f.client.preview(batch());
    assert.deepEqual(deadlines, [12000, 120000]);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('declared oversized responses are canceled before parsing and incorrect lengths are rejected', async () => {
  let canceled = false;
  const f = fixture(() => new Response(new ReadableStream({ cancel() { canceled = true; } }), {
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(LIMITS.json + 1) } }));
  await rejectsCode(f.client.list(), 'REMOTE_INVALID_RESPONSE');
  assert.equal(canceled, true);
  for (const declared of ['-1', '1.5', 'abc', '1']) {
    const wrong = fixture(() => json(snapshot(), { headers: { 'Content-Type': 'application/json', 'Content-Length': declared } }));
    await rejectsCode(wrong.client.list(), 'REMOTE_INVALID_RESPONSE');
  }
});

test('streamed responses without Content-Length remain bounded', async () => {
  let canceled = false;
  const f = fixture(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(LIMITS.json + 1)); }, cancel() { canceled = true; } }), { headers: { 'Content-Type': 'application/json' } }));
  await rejectsCode(f.client.list(), 'REMOTE_INVALID_RESPONSE');
  assert.equal(canceled, true);
});

test('response item validation rejects invalid IDs, revisions, incomplete prompts, hashes and duplicate items', () => {
  for (const bad of [item({ id: 0 }), item({ revision: 0 }), item({ type: 'remote' }), item({ prompts: { en: 'Full English', zh: '' } }),
    item({ prompts: { en: 'Full English\0', zh: '中文' } }), item({ sha256: 'a'.repeat(63) }), item({ size: LIMITS.image + 1 }), item({ mime: 'text/html' })]) {
    throwsCode(() => validateItem(bad), 'REMOTE_INVALID_RESPONSE');
  }
  throwsCode(() => validateSnapshot(snapshot({ items: [item(), item()] })), 'REMOTE_INVALID_RESPONSE');
  assert.equal(validateItem(item()).prompts.en, item().prompts.en);
});

test('get rejects another record or forged input and never builds a path from metadata URLs', async () => {
  const f = fixture(() => json({ revision: 3, item: item({ id: 52 }) }));
  await rejectsCode(f.client.get(51), 'REMOTE_INVALID_RESPONSE');
  assert.equal(f.calls[0].url, 'https://portrait.example/portrait-studio/v1/portraits/51');
  const empty = fixture();
  for (const value of [0, -1, 1000000, '51', '../51', null]) await rejectsCode(empty.client.get(value), 'INVALID_INPUT');
  assert.equal(empty.calls.length, 0);
});

test('image reads use the fixed ID/revision route and verify exact bytes, MIME and SHA-256', async () => {
  const f = fixture(() => new Response(imageBytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(imageBytes.length) } }));
  assert.deepEqual(await f.client.image(item({ image_url: 'https://other.example/leak' })), imageBytes);
  assert.equal(f.calls[0].url, 'https://portrait.example/portrait-studio/v1/images/51?revision=1');
  for (const [bytes, mime] of [[Buffer.from(imageBytes).fill(9, imageBytes.length - 1), 'image/png'], [imageBytes, 'image/jpeg'], [imageBytes.subarray(0, imageBytes.length - 1), 'image/png']]) {
    const bad = fixture(() => new Response(bytes, { headers: { 'Content-Type': mime } }));
    await rejectsCode(bad.client.image(item()), 'CONFLICT');
  }
});

test('batch multipart preserves original JSON bytes, explicit nested image paths and derived field origin', async () => {
  const f = fixture(() => json(preview()));
  const manifestBytes = Buffer.from(' { "images": [], "source_file": "original.json" }\n');
  const derivedChinesePrompts = { 1: '衍生译文完整保留。' };
  await f.client.preview(batch({ manifestRelativePath: 'metadata/manifest.json', manifestBytes,
    derivedChinesePrompts, images: [{ relativePath: 'generated_portraits/001.png', bytes: imageBytes, mime: 'image/png' }] }));
  const call = f.calls[0];
  assert.equal(call.url, 'https://portrait.example/portrait-studio/v1/batches/preview');
  assert.equal(call.init.method, 'POST');
  assert.equal(Object.hasOwn(call.init.headers, 'Content-Type'), false);
  const form = call.init.body;
  assert.deepEqual(JSON.parse(form.get('metadata')), { manifestRelativePath: 'metadata/manifest.json', type: 'photo', collisionPolicy: 'allocate-new', derivedChinesePrompts });
  assert.equal(form.get('manifest').name, 'manifest.json');
  assert.deepEqual(Buffer.from(await form.get('manifest').arrayBuffer()), manifestBytes);
  assert.equal(form.get('image:generated_portraits/001.png').name, '001.png');
  assert.deepEqual(Buffer.from(await form.get('image:generated_portraits/001.png').arrayBuffer()), imageBytes);
  assert.deepEqual([...form.keys()], ['metadata', 'manifest', 'image:generated_portraits/001.png']);
});

test('unsafe or duplicate upload paths are rejected before any request is sent', async () => {
  const f = fixture(() => json(preview()));
  for (const relativePath of ['/tmp/private.png', '../private.png', 'images/../private.png', 'images\\private.png', 'C:private.png', 'images//private.png', 'images/\0.png']) {
    assert.equal(safeRelativePath(relativePath), false);
    await rejectsCode(f.client.preview(batch({ images: [{ relativePath, bytes: imageBytes, mime: 'image/png' }] })), 'INVALID_IMAGE');
  }
  const image = { relativePath: 'images/001.png', bytes: imageBytes, mime: 'image/png' };
  await rejectsCode(f.client.preview(batch({ images: [image, image] })), 'INVALID_IMAGE');
  await rejectsCode(f.client.preview(batch({ manifestRelativePath: '../manifest.json' })), 'INVALID_INPUT');
  assert.equal(f.calls.length, 0);
});

test('forged preview responses and IDs fail before commit/cancel requests', async () => {
  const f = fixture(() => json(preview({ previewId: '../other-library', canImport: true })));
  await rejectsCode(f.client.preview(batch()), 'REMOTE_INVALID_RESPONSE');
  const empty = fixture();
  for (const value of ['../secret', '', 51, null]) {
    await rejectsCode(empty.client.commit(value, { confirmed: true, expectedVersion: 3 }), 'INVALID_BATCH_SELECTION');
    await rejectsCode(empty.client.cancel(value), 'INVALID_BATCH_SELECTION');
  }
  assert.equal(empty.calls.length, 0);
});

test('commit, cancel and mutations use their fixed HTTP methods and do not expose server filesystem paths', async () => {
  const f = fixture((_url, init) => json(init.method === 'DELETE' ? { cancelled: true } : { snapshot: snapshot(), report: { imported: 1 } }));
  await f.client.commit(previewID, { confirmed: true, expectedVersion: 3 });
  await f.client.cancel(previewID);
  await f.client.mutate('create', { id: 51, label: 'Label', type: 'photo', prompts: item().prompts, expectedVersion: 3 }, { bytes: imageBytes, mime: 'image/png' });
  assert.deepEqual(f.calls.map(call => [call.init.method, call.url]), [
    ['POST', `https://portrait.example/portrait-studio/v1/batches/${previewID}/commit`],
    ['DELETE', `https://portrait.example/portrait-studio/v1/batches/${previewID}`],
    ['POST', 'https://portrait.example/portrait-studio/v1/portraits'],
  ]);
  assert.equal(f.calls[1].init.body, undefined);
  assert.equal(JSON.parse(f.calls[2].init.body.get('metadata')).id, 51);
  assert.equal(f.calls[2].init.body.get('image').name, 'portrait.png');
});

test('public platform initialization status omits all configured authorization and does not imply an authenticated session', async () => {
  for (const initialized of [false, true]) {
    const f = fixture(() => json({ initialized, authenticated: false }), { authorization: 'Basic FAKE-environment-gateway' });
    assert.deepEqual(await f.client.authStatus(), { initialized, authenticated: false });
    assert.equal(f.calls[0].url, 'https://portrait.example/portrait-studio/v1/auth/status');
    assert.equal(f.calls[0].init.method, 'GET');
    assert.equal(f.calls[0].init.headers.Authorization, undefined);
    assert.equal(f.client.sessionMetadata, null);
    await rejectsCode(f.client.session(), 'AUTH_REQUIRED');
    assert.equal(f.calls.length, 1);
  }
  for (const invalid of [{ initialized: 1, authenticated: false }, { initialized: true, authenticated: true }, { initialized: true, authenticated: false, sessionToken: fakeSessionToken }]) {
    await rejectsCode(fixture(() => json(invalid)).client.authStatus(), 'REMOTE_INVALID_RESPONSE');
  }
});

test('platform login returns a new same-origin private Bearer client and only frozen safe session metadata', async () => {
  const response = loginReply(), credentials = platformCredentials(), gateway = 'Basic FAKE-environment-gateway';
  const f = fixture(url => json(url.endsWith('/v1/auth/login') ? response : snapshot()), { authorization: gateway });
  const { client, session } = await f.client.login(credentials);
  assert.notEqual(client, f.client);
  assert.deepEqual(session, { username: 'admin', expiresAt: response.expiresAt });
  assert.equal(Object.isFrozen(session), true);
  assert.deepEqual(client.sessionMetadata, { kind: 'platform', username: 'admin', expiresAt: response.expiresAt });
  assert.equal(Object.isFrozen(client.sessionMetadata), true);
  assert.equal(f.client.sessionMetadata, null);
  assert.equal(client.connection.endpoint, f.client.connection.endpoint);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), credentials);
  assert.equal(f.calls[0].init.redirect, 'error');
  await client.list(); await f.client.list();
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer ' + fakeSessionToken);
  assert.equal(f.calls[2].init.headers.Authorization, gateway);
  assert(f.calls.every(call => call.url.startsWith('https://portrait.example/portrait-studio/')));
  for (const privateValue of [fakeSessionToken, 'Bearer ' + fakeSessionToken, gateway, credentials.password]) {
    assert.equal(JSON.stringify({ client, session }).includes(privateValue), false);
  }
});

test('platform credentials are fixed-admin, control-free and bounded by UTF-8 bytes without truncation or password trimming', async () => {
  const f = fixture(() => json(loginReply()));
  for (const bad of [null, {}, { username: 'other', password: 'FAKE' }, { username: 'Admin', password: 'FAKE' },
    { username: 'admin', password: 'FAKE', endpoint: 'https://other.example/' }, { username: 'admin', password: '' },
    { username: 'admin', password: 'FAKE\n' }, { username: 'admin', password: 'FAKE\0' }, { username: 'admin', password: '\ud800' },
    { username: 'admin', password: 'x'.repeat(1025) }, { username: 'admin', password: '密'.repeat(342) }]) {
    await rejectsCode(f.client.login(bad), 'INVALID_INPUT');
  }
  assert.equal(f.calls.length, 0);
  const password = '  ' + '密'.repeat(340) + '  ';
  assert.equal(Buffer.byteLength(password), 1024);
  await f.client.login({ username: 'admin', password });
  assert.equal(JSON.parse(f.calls[0].init.body).password, password);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
});

test('malformed platform tokens, unexpected fields, usernames and expiration values fail without exposing server secrets', async () => {
  for (const value of [loginReply({ sessionToken: 'x'.repeat(42) }), loginReply({ sessionToken: '+'.repeat(43) }),
    loginReply({ sessionToken: 'B'.repeat(43) }), loginReply({ username: 'root' }), loginReply({ expiresAt: 'private-server-value' }),
    loginReply({ extra: '/private/data' }), { username: 'admin', expiresAt: loginReply().expiresAt }]) {
    const f = fixture(() => json(value));
    await assert.rejects(f.client.login(platformCredentials()), error => error.code === 'REMOTE_INVALID_RESPONSE' && error.message === 'REMOTE_INVALID_RESPONSE' && !error.cause);
    assert.equal(f.client.sessionMetadata, null);
  }
});

test('platform login permits only configured HTTPS or explicit pinned loopback development and never changes the endpoint', async () => {
  const f = fixture(() => json(loginReply()), { baseURL: 'http://127.0.0.1:4137/', allowLoopback: true });
  const { client } = await f.client.login(platformCredentials());
  assert.equal(client.connection.endpoint, 'http://127.0.0.1:4137/');
  assert.equal(client.withoutSession().connection.endpoint, client.connection.endpoint);
  assert.equal(f.calls[0].init.redirect, 'error');
  throwsCode(() => fixture(undefined, { baseURL: 'http://127.0.0.1:4137/' }), 'REMOTE_NOT_CONFIGURED');
  throwsCode(() => fixture(undefined, { baseURL: 'http://other.example/', allowLoopback: true }), 'REMOTE_NOT_CONFIGURED');
});

test('platform JSON 401 codes remain distinct and sanitized while legacy Basic challenges and old auth routes have separate errors', async () => {
  for (const code of ['SESSION_EXPIRED', 'AUTH_REQUIRED', 'AUTH_NOT_INITIALIZED', 'INVALID_CREDENTIALS']) {
    const f = fixture(() => authError(code));
    await assert.rejects(f.client.login(platformCredentials()), error => error.code === code && error.message === code && !error.cause);
    assert.equal(f.calls.length, 1);
  }
  for (const action of ['authStatus', 'login']) {
    const f = fixture(() => new Response('<html>private existing Basic gateway</html>', { status: 401, headers: { 'Content-Type': 'text/html', 'WWW-Authenticate': 'Basic realm="restricted"' } }));
    await rejectsCode(action === 'login' ? f.client.login(platformCredentials()) : f.client.authStatus(), 'REMOTE_GATEWAY_AUTH_REQUIRED');
    assert.equal(f.calls[0].init.headers.Authorization, undefined);
  }
  const old = fixture(() => new Response('<html>old service without platform auth</html>', { status: 404, headers: { 'Content-Type': 'text/html' } }));
  await rejectsCode(old.client.authStatus(), 'PLATFORM_AUTH_UNAVAILABLE');
});

test('protected platform requests clear their private token on server expiry, missing auth and unknown gateway 401 responses', async () => {
  for (const response of [() => authError('SESSION_EXPIRED'), () => authError('AUTH_REQUIRED'),
    () => new Response('<html>private gateway</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }),
    () => authError('PRIVATE_UNRECOGNIZED_CODE'),
    () => new Response('{malformed-private-json', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('private-response-never-read', { status: 401, headers: { 'Content-Type': 'application/json', 'Content-Length': String(LIMITS.json + 1) } })]) {
    const f = fixture(url => url.endsWith('/v1/auth/login') ? json(loginReply()) : url.endsWith('/v1/auth/status') ? json({ initialized: true, authenticated: false }) : response());
    const { client } = await f.client.login(platformCredentials());
    await assert.rejects(client.list(), error => ['SESSION_EXPIRED', 'AUTH_REQUIRED', 'REMOTE_AUTH_REQUIRED', 'REMOTE_INVALID_RESPONSE'].includes(error.code));
    assert.equal(client.sessionMetadata, null);
    assert.equal(client.connection.authorizationProvided, false);
    await rejectsCode(client.session(), 'AUTH_REQUIRED');
    await client.authStatus();
    assert.equal(f.calls.at(-1).init.headers.Authorization, undefined);
    assert.equal(JSON.stringify(client).includes(fakeSessionToken), false);
  }
});

test('local session expiration prevents a protected request and clears safe metadata and authorization', async () => {
  const realNow = Date.now, now = realNow(), f = fixture(() => json(loginReply({ expiresAt: new Date(now + 60000).toISOString() })));
  const { client } = await f.client.login(platformCredentials());
  try {
    Date.now = () => now + 60001;
    await rejectsCode(client.list(), 'SESSION_EXPIRED');
    assert.equal(f.calls.length, 1, 'expired private token is never sent');
    assert.equal(client.sessionMetadata, null);
    assert.equal(client.connection.authorizationProvided, false);
  } finally { Date.now = realNow; }
  const expired = fixture(() => json(loginReply({ expiresAt: new Date(now - 1000).toISOString() })));
  await rejectsCode(expired.client.login(platformCredentials()), 'SESSION_EXPIRED');
});

test('session refresh and logout use only the fixed Bearer routes and return safe metadata without raw tokens', async () => {
  const response = loginReply();
  const f = fixture((url, init) => json(url.endsWith('/v1/auth/login') ? response : init.method === 'DELETE' ? { loggedOut: true } : { username: 'admin', expiresAt: response.expiresAt }));
  const { client } = await f.client.login(platformCredentials());
  assert.deepEqual(await client.session(), { username: 'admin', expiresAt: response.expiresAt });
  assert.deepEqual(await client.logout(), { loggedOut: true });
  assert.deepEqual(f.calls.slice(1).map(call => [call.init.method, call.url]), [
    ['GET', 'https://portrait.example/portrait-studio/v1/auth/session'], ['DELETE', 'https://portrait.example/portrait-studio/v1/auth/session'],
  ]);
  assert(f.calls.slice(1).every(call => call.init.headers.Authorization === 'Bearer ' + fakeSessionToken));
  assert.equal(f.calls[2].init.body, undefined);
  assert.equal(client.sessionMetadata, null);
  assert.equal(client.connection.authorizationProvided, false);
});

test('logout transport failure still clears the local token without claiming server revocation succeeded', async () => {
  const f = fixture((url, init) => {
    if (url.endsWith('/v1/auth/login')) return json(loginReply());
    if (init.method === 'DELETE') throw new Error('private logout transport details');
    return json(snapshot());
  });
  const { client } = await f.client.login(platformCredentials());
  await rejectsCode(client.logout(), 'REMOTE_UNAVAILABLE');
  assert.equal(client.sessionMetadata, null);
  await rejectsCode(client.session(), 'AUTH_REQUIRED');
  await client.list();
  assert.equal(f.calls.at(-1).init.headers.Authorization, undefined);
});

test('failed candidate login preserves a valid previous session and tokenless clones preserve only explicit same-host legacy Basic configuration', async () => {
  let attempts = 0;
  const f = fixture(url => url.endsWith('/v1/auth/login') ? ++attempts === 1 ? json(loginReply()) : authError('INVALID_CREDENTIALS') : json(snapshot()),
    { authorization: 'Basic FAKE-explicit-gateway' });
  const { client } = await f.client.login(platformCredentials());
  await rejectsCode(client.login({ username: 'admin', password: 'FAKE-wrong-password' }), 'INVALID_CREDENTIALS');
  assert.equal(f.calls[1].init.headers.Authorization, undefined);
  assert.equal(client.sessionMetadata.username, 'admin');
  await client.list(); assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer ' + fakeSessionToken);
  const tokenless = client.withoutSession();
  assert.equal(tokenless.connection.endpoint, client.connection.endpoint);
  assert.equal(tokenless.sessionMetadata, null);
  await tokenless.list(); assert.equal(f.calls.at(-1).init.headers.Authorization, 'Basic FAKE-explicit-gateway');
  client.clearSession(); assert.equal(client.sessionMetadata, null);
  assert.equal(JSON.stringify(tokenless).includes(fakeSessionToken), false);
});

test('platform auth responses are capped at 64 KiB and public probes retain short deadlines', async () => {
  let canceled = false;
  const oversized = fixture(() => new Response(new ReadableStream({ cancel() { canceled = true; } }),
    { headers: { 'Content-Type': 'application/json', 'Content-Length': String(64 * 1024 + 1) } }));
  await rejectsCode(oversized.client.login(platformCredentials()), 'REMOTE_INVALID_RESPONSE');
  assert.equal(canceled, true);
  const originalSetTimeout = globalThis.setTimeout, deadlines = [];
  globalThis.setTimeout = (action, milliseconds, ...args) => { deadlines.push(milliseconds); return originalSetTimeout(action, milliseconds, ...args); };
  try {
    const f = fixture(url => json(url.endsWith('/status') ? { initialized: true, authenticated: false } : loginReply()));
    await f.client.authStatus(); await f.client.login(platformCredentials());
    assert.deepEqual(deadlines, [12000, 12000]);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});
