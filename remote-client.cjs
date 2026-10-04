'use strict';

const { createHash } = require('node:crypto');

const LIMITS = Object.freeze({ json: 32 * 1024 * 1024, image: 30 * 1024 * 1024, images: 1024 * 1024 * 1024, records: 10000, prompt: 65536 });
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLATFORM_AUTH_CODES = new Set(['SESSION_EXPIRED', 'AUTH_REQUIRED', 'AUTH_NOT_INITIALIZED', 'INVALID_CREDENTIALS']);
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const AUTH_JSON = 64 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validId = value => Number.isSafeInteger(value) && value >= 1 && value <= 999999;
const revision = value => Number.isSafeInteger(value) && value >= 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRelativePath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.startsWith('/') && !/[\u0000-\u001f\u007f\\:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && part.length <= 255);

class RemoteError extends Error {
  constructor(code) { super(code); this.name = 'RemoteError'; this.code = code; }
}
const fail = code => { throw new RemoteError(code); };
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  fail('INVALID_IMAGE');
}
function validateEndpoint(value, allowLoopback = false) {
  if (typeof value !== 'string' || value.length > 2048) fail('REMOTE_NOT_CONFIGURED');
  let url;
  try { url = new URL(value); } catch { fail('REMOTE_NOT_CONFIGURED'); }
  const rawPath = /^https?:\/\/[^/?#]+(\/[^?#]*)?$/.exec(value)?.[1] || '/';
  if (url.username || url.password || url.search || url.hash || rawPath !== url.pathname || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname)) fail('REMOTE_NOT_CONFIGURED');
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && Boolean(url.port);
  if (url.protocol !== 'https:' && !(allowLoopback && loopback)) fail('REMOTE_NOT_CONFIGURED');
  return { origin: url.origin, prefix: url.pathname, endpoint: url.origin + url.pathname, transport: loopback ? 'loopback-development' : 'https' };
}
function validateItem(item) {
  if (!plain(item) || !validId(item.id) || !revision(item.revision) || item.revision < 1 || typeof item.label !== 'string' || item.label.length > 160
    || !['photo', 'art'].includes(item.type) || !plain(item.prompts) || !['en', 'zh'].every(language => typeof item.prompts[language] === 'string' && item.prompts[language].trim() && item.prompts[language].length <= LIMITS.prompt && !item.prompts[language].includes('\0'))
    || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > LIMITS.image || !MIME.has(item.mime)) fail('REMOTE_INVALID_RESPONSE');
  return item;
}
function validateSnapshot(snapshot) {
  if (!plain(snapshot) || snapshot.configured !== true || typeof snapshot.writable !== 'boolean' || typeof snapshot.root !== 'string'
    || !revision(snapshot.revision) || !Array.isArray(snapshot.items) || snapshot.items.length > LIMITS.records) fail('REMOTE_INVALID_RESPONSE');
  const ids = new Set();
  for (const item of snapshot.items) { validateItem(item); if (ids.has(item.id)) fail('REMOTE_INVALID_RESPONSE'); ids.add(item.id); }
  return snapshot;
}
async function boundedResponse(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body?.cancel(); fail('REMOTE_INVALID_RESPONSE'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); fail('REMOTE_INVALID_RESPONSE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  if (declared && Number(declared) !== total) fail('REMOTE_INVALID_RESPONSE');
  return Buffer.concat(chunks, total);
}

function sessionValue(value) {
  if (!plain(value) || value.username !== 'admin' || typeof value.expiresAt !== 'string' || value.expiresAt.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt))) fail('REMOTE_INVALID_RESPONSE');
  return Object.freeze({ username: 'admin', expiresAt: value.expiresAt });
}

class RemoteClient {
  #origin; #prefix; #authorization; #fetch; #gatewayAuthorization; #session = null; #allowLoopback;
  constructor({ baseURL, allowLoopback = false, authorization, fetchImpl = globalThis.fetch } = {}) {
    const endpoint = validateEndpoint(baseURL, allowLoopback);
    if (authorization !== undefined && (typeof authorization !== 'string' || !authorization.trim() || authorization.length > 8192 || /[\r\n\0]/.test(authorization))) fail('REMOTE_NOT_CONFIGURED');
    if (typeof fetchImpl !== 'function') fail('REMOTE_UNAVAILABLE');
    this.#origin = endpoint.origin; this.#prefix = endpoint.prefix; this.#authorization = authorization; this.#fetch = fetchImpl;
    this.#gatewayAuthorization = /^Basic /i.test(authorization || '') ? authorization : undefined;
    this.#allowLoopback = endpoint.transport === 'loopback-development';
    this.connection = Object.freeze({ transport: endpoint.transport, encrypted: endpoint.transport === 'https', authorizationProvided: Boolean(authorization), endpoint: endpoint.endpoint });
  }
  #expireSession() {
    if (this.#session && Date.now() >= Date.parse(this.#session.expiresAt)) { this.clearSession(); return true; }
    return false;
  }
  get sessionMetadata() { this.#expireSession(); return this.#session; }
  clearSession() {
    this.#authorization = this.#gatewayAuthorization;
    this.#session = null;
    this.connection = Object.freeze({ ...this.connection, authorizationProvided: Boolean(this.#authorization) });
  }
  withoutSession() {
    return new RemoteClient({ baseURL: this.#origin + this.#prefix, allowLoopback: this.#allowLoopback, authorization: this.#gatewayAuthorization, fetchImpl: this.#fetch });
  }
  async authStatus() {
    const value = await this.#request('GET', '/v1/auth/status', undefined, false, 12000, null, AUTH_JSON);
    if (!plain(value) || Object.keys(value).length !== 2 || typeof value.initialized !== 'boolean' || value.authenticated !== false) fail('REMOTE_INVALID_RESPONSE');
    return { initialized: value.initialized, authenticated: false };
  }
  async login(value) {
    if (!plain(value) || Object.keys(value).length !== 2 || value.username !== 'admin' || typeof value.password !== 'string'
      || value.password.length === 0 || Buffer.byteLength(value.password, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(value.password)
      || Buffer.from(value.password, 'utf8').toString('utf8') !== value.password) fail('INVALID_INPUT');
    const data = await this.#request('POST', '/v1/auth/login', { username: 'admin', password: value.password }, false, 12000, null, AUTH_JSON);
    if (!plain(data) || Object.keys(data).length !== 3 || typeof data.sessionToken !== 'string' || !SESSION_TOKEN.test(data.sessionToken)
      || Buffer.from(data.sessionToken, 'base64url').toString('base64url') !== data.sessionToken) fail('REMOTE_INVALID_RESPONSE');
    const session = sessionValue(data);
    if (Date.now() >= Date.parse(session.expiresAt)) fail('SESSION_EXPIRED');
    const client = new RemoteClient({ baseURL: this.#origin + this.#prefix, allowLoopback: this.#allowLoopback, authorization: 'Bearer ' + data.sessionToken, fetchImpl: this.#fetch });
    client.#gatewayAuthorization = this.#gatewayAuthorization;
    client.#session = Object.freeze({ kind: 'platform', ...session });
    return { client, session };
  }
  async session() {
    if (this.#expireSession()) fail('SESSION_EXPIRED');
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(this.#authorization || '')) fail('AUTH_REQUIRED');
    const data = await this.#request('GET', '/v1/auth/session', undefined, false, 12000, undefined, AUTH_JSON);
    if (!plain(data) || Object.keys(data).length !== 2) { this.clearSession(); fail('REMOTE_INVALID_RESPONSE'); }
    let session;
    try { session = sessionValue(data); } catch (error) { this.clearSession(); throw error; }
    if (Date.now() >= Date.parse(session.expiresAt)) { this.clearSession(); fail('SESSION_EXPIRED'); }
    this.#session = Object.freeze({ kind: 'platform', ...session });
    return session;
  }
  async logout() {
    try {
      if (this.#expireSession()) fail('SESSION_EXPIRED');
      if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(this.#authorization || '')) fail('AUTH_REQUIRED');
      const data = await this.#request('DELETE', '/v1/auth/session', undefined, false, 12000, undefined, AUTH_JSON);
      if (!plain(data) || Object.keys(data).length !== 1 || data.loggedOut !== true) fail('REMOTE_INVALID_RESPONSE');
      return { loggedOut: true };
    } finally { this.clearSession(); }
  }
  withBasicCredentials(value) {
    if (this.connection.transport !== 'https') fail('REMOTE_NOT_CONFIGURED');
    if (!plain(value) || Object.keys(value).length !== 2 || Object.keys(value).some(key => !['username', 'password'].includes(key))
      || typeof value.username !== 'string' || !value.username || value.username.length > 256 || /[:\u0000-\u001f\u007f]/.test(value.username)
      || typeof value.password !== 'string' || !value.password || value.password.length > 8192 || /[\u0000-\u001f\u007f]/.test(value.password)) fail('INVALID_INPUT');
    const authorization = 'Basic ' + Buffer.from(`${value.username}:${value.password}`, 'utf8').toString('base64');
    if (authorization.length > 8192) fail('INVALID_INPUT');
    return new RemoteClient({ baseURL: this.#origin + this.#prefix, authorization, fetchImpl: this.#fetch });
  }
  async #request(method, route, body, binary = false, timeout = 120000, authorizationOverride, jsonMaximum = LIMITS.json) {
    const expired = this.#expireSession();
    if (expired && authorizationOverride === undefined) fail('SESSION_EXPIRED');
    const authorization = authorizationOverride === undefined ? this.#authorization : authorizationOverride;
    const controller = new AbortController();
    let deadlineExpired = false;
    let authenticationRejected = false;
    const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, timeout);
    try {
      const headers = { Accept: binary ? 'image/png,image/jpeg,image/webp' : 'application/json' };
      if (authorization) headers.Authorization = authorization;
      if (body !== undefined && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      const response = await this.#fetch(this.#origin + this.#prefix + route.slice(1), { method, headers, body, redirect: 'error', signal: controller.signal });
      authenticationRejected = response.status === 401;
      // HTTP gateway/authentication errors can be HTML. Classify the observed
      // status before parsing any body, without treating it as proof of health.
      const isJSON = /^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '');
      const platformPublicRoute = ['/v1/auth/status', '/v1/auth/login'].includes(route);
      const statusCode = response.status === 401 && !isJSON ? (platformPublicRoute ? 'REMOTE_GATEWAY_AUTH_REQUIRED' : 'REMOTE_AUTH_REQUIRED')
        : response.status === 403 ? 'REMOTE_FORBIDDEN'
          : [502, 503, 504].includes(response.status) ? 'REMOTE_SERVICE_UNAVAILABLE'
            : response.status === 404 && method === 'GET' && route === '/v1/library' ? 'REMOTE_ROUTE_MISSING'
              : response.status === 404 && method === 'GET' && route === '/v1/auth/status' ? 'PLATFORM_AUTH_UNAVAILABLE' : undefined;
      if (statusCode) {
        try { await response.body?.cancel(); } catch { /* Discard private response details. */ }
        fail(statusCode);
      }
      const bytes = await boundedResponse(response, binary && response.ok ? LIMITS.image : jsonMaximum);
      if (response.status === 401) {
        let failure;
        try { failure = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { /* No private response text is exposed. */ }
        const code = failure?.ok === false && plain(failure.error) && PLATFORM_AUTH_CODES.has(failure.error.code) ? failure.error.code
          : platformPublicRoute ? 'REMOTE_GATEWAY_AUTH_REQUIRED' : 'REMOTE_AUTH_REQUIRED';
        fail(code);
      }
      if (binary && response.ok) return { bytes, mime: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() };
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) fail('REMOTE_INVALID_RESPONSE');
      let result; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('REMOTE_INVALID_RESPONSE'); }
      if (!plain(result) || typeof result.ok !== 'boolean') fail('REMOTE_INVALID_RESPONSE');
      if (!response.ok || !result.ok) {
        const code = result.error?.code;
        fail(typeof code === 'string' && /^[A-Z][A-Z_]{0,63}$/.test(code) ? code : 'REMOTE_INVALID_RESPONSE');
      }
      if (!plain(result.data)) fail('REMOTE_INVALID_RESPONSE');
      return result.data;
    } catch (error) {
      if (authorizationOverride === undefined && /^Bearer /i.test(authorization || '') && (authenticationRejected || error instanceof RemoteError && ['SESSION_EXPIRED', 'AUTH_REQUIRED'].includes(error.code))) this.clearSession();
      if (error instanceof RemoteError) {
        throw error;
      }
      fail(deadlineExpired ? 'REMOTE_TIMEOUT' : 'REMOTE_UNAVAILABLE');
    }
    finally { clearTimeout(timer); }
  }
  async list() { return validateSnapshot(await this.#request('GET', '/v1/library', undefined, false, 12000)); }
  async get(id) {
    if (!validId(id)) fail('INVALID_INPUT');
    const data = await this.#request('GET', `/v1/portraits/${id}`);
    if (!revision(data.revision) || validateItem(data.item).id !== id) fail('REMOTE_INVALID_RESPONSE');
    return data;
  }
  async image(item) {
    validateItem(item);
    const value = await this.#request('GET', `/v1/images/${item.id}?revision=${item.revision}`, undefined, true);
    if (value.bytes.length !== item.size || value.mime !== item.mime || imageMime(value.bytes) !== item.mime || sha(value.bytes) !== item.sha256) fail('CONFLICT');
    return value.bytes;
  }
  async mutate(method, payload, image) {
    if (!['create', 'update', 'remove'].includes(method) || !plain(payload) || !validId(payload.id)) fail('INVALID_INPUT');
    let body = payload;
    if (method !== 'remove') {
      const form = new FormData(); form.append('metadata', JSON.stringify(payload));
      if (image) {
        if (!Buffer.isBuffer(image.bytes) || image.bytes.length > LIMITS.image || !MIME.has(image.mime) || imageMime(image.bytes) !== image.mime) fail('INVALID_IMAGE');
        form.append('image', new Blob([image.bytes], { type: image.mime }), 'portrait.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mime]));
      }
      body = form;
    }
    const data = await this.#request(method === 'create' ? 'POST' : method === 'update' ? 'PATCH' : 'DELETE', method === 'create' ? '/v1/portraits' : `/v1/portraits/${payload.id}`, body);
    validateSnapshot(data.snapshot); return data;
  }
  async preview({ manifestRelativePath, manifestBytes, type, images, derivedChinesePrompts }) {
    if (!safeRelativePath(manifestRelativePath) || !Buffer.isBuffer(manifestBytes) || manifestBytes.length > LIMITS.json || !['photo', 'art'].includes(type) || !Array.isArray(images) || images.length > 5000) fail('INVALID_INPUT');
    const form = new FormData();
    form.append('metadata', JSON.stringify({ manifestRelativePath, type, collisionPolicy: 'allocate-new', ...(derivedChinesePrompts ? { derivedChinesePrompts } : {}) }));
    form.append('manifest', new Blob([manifestBytes], { type: 'application/json' }), manifestRelativePath.split('/').at(-1));
    const paths = new Set(); let total = 0;
    for (const image of images) {
      if (!safeRelativePath(image.relativePath) || paths.has(image.relativePath) || !Buffer.isBuffer(image.bytes) || image.bytes.length > LIMITS.image || imageMime(image.bytes) !== image.mime) fail('INVALID_IMAGE');
      paths.add(image.relativePath); total += image.bytes.length; if (total > LIMITS.images) fail('BATCH_TOO_LARGE');
      form.append(`image:${image.relativePath}`, new Blob([image.bytes], { type: image.mime }), image.relativePath.split('/').at(-1));
    }
    const data = await this.#request('POST', '/v1/batches/preview', form);
    if (!UUID.test(data.previewId) || !revision(data.revision) || !Array.isArray(data.items) || !Array.isArray(data.issues) || !Array.isArray(data.unpaired) || typeof data.canImport !== 'boolean') fail('REMOTE_INVALID_RESPONSE');
    return data;
  }
  async commit(previewId, payload) {
    if (!UUID.test(previewId)) fail('INVALID_BATCH_SELECTION');
    const data = await this.#request('POST', `/v1/batches/${previewId}/commit`, payload);
    validateSnapshot(data.snapshot); if (!plain(data.report)) fail('REMOTE_INVALID_RESPONSE'); return data;
  }
  async cancel(previewId) {
    if (!UUID.test(previewId)) fail('INVALID_BATCH_SELECTION');
    return this.#request('DELETE', `/v1/batches/${previewId}`, undefined, false, 5000);
  }
}

module.exports = { RemoteClient, RemoteError, validateEndpoint, validateItem, validateSnapshot, imageMime, safeRelativePath, LIMITS };
