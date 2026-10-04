'use strict';

// Browser development preview only. This module has no filesystem write API and
// deliberately never constructs LocalLibrary or runs its recovery/locking code.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateIndex, imageMime } = require('./local-library.cjs');
const { errorResult } = require('./localization.cjs');
const defaults = require('./assets/default-library.json');

const AUTHORIZED_ROOT = '/Users/jie/Github/photo_generate_desktop/photo_repo';
const PREVIEW_ORIGIN = 'http://127.0.0.1:5173';
const PREVIEW_HOST = '127.0.0.1:5173';
const MAX_INDEX = 32 * 1024 * 1024;
const MAX_IMAGE = 30 * 1024 * 1024;
const API = '/__preview/api/';
const idPattern = /^[1-9]\d{0,5}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function allowedRequest(request) {
  if (request.headers.host !== PREVIEW_HOST) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== PREVIEW_ORIGIN) return false;
  const site = request.headers['sec-fetch-site'];
  return site === undefined || ['none', 'same-origin', 'same-site'].includes(site);
}

function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(JSON.stringify(value));
}

async function createPreviewLibrary({ root = defaults.root, expectedRoot = AUTHORIZED_ROOT } = {}) {
  // The optional constructor arguments are used by isolated Node fixtures. They
  // are never exposed through HTTP; the Vite plugin always uses the fixed root.
  if (typeof root !== 'string' || !path.isAbsolute(root) || root !== expectedRoot || path.resolve(root) !== root) fail('INVALID_ROOT');
  if (typeof validateIndex !== 'function' || typeof imageMime !== 'function') fail('INVALID_DATA');
  const directoryPins = new Map();
  async function checkDirectory(absolute) {
    const stat = await fs.lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH');
    const prior = directoryPins.get(absolute);
    if (prior && !sameIdentity(stat, prior)) fail('CONFLICT');
    directoryPins.set(absolute, { dev: stat.dev, ino: stat.ino });
  }
  async function checkRoot() {
    let current = path.parse(root).root;
    for (const part of root.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      await checkDirectory(current);
    }
    if (await fs.realpath(root) !== root) fail('UNSAFE_PATH');
  }
  async function safeFile(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH');
    await checkRoot();
    let current = root;
    const parts = relative.split('/');
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      await checkDirectory(current);
    }
    const target = path.join(current, parts.at(-1));
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(target) !== target) fail('UNSAFE_PATH');
    return { target, stat };
  }
  async function read(relative, maximum) {
    const selected = await safeFile(relative);
    const handle = await fs.open(selected.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameFile(before, selected.stat)) fail('CONFLICT');
      if (before.size > maximum) fail('INVALID_DATA');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
        if (!result.bytesRead) fail('CONFLICT');
        offset += result.bytesRead;
      }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
      const after = await handle.stat();
      const current = await safeFile(relative);
      if (extra.bytesRead || !sameFile(before, after) || !sameFile(after, current.stat)) fail('CONFLICT');
      return bytes;
    } finally { await handle.close(); }
  }
  async function loadIndex() {
    const bytes = await read('.portrait-studio/library.json', MAX_INDEX);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('INVALID_DATA'); }
    return validateIndex(value);
  }
  function publicItem(item) {
    return { id: item.id, label: item.label, type: item.type, prompts: { en: item.prompts.en, zh: item.prompts.zh },
      image: item.image, imageRel: item.imageRel, revision: item.revision,
      ...(item.sourceMetadata ? { sourceMetadata: item.sourceMetadata, sourceImport: item.sourceImport } : {}),
      image_url: `${API}images/${item.id}?revision=${item.revision}` };
  }
  await checkRoot();
  // Startup validates the existing index without creating a folder or index.
  await loadIndex();
  async function middleware(request, response, next) {
    if (!allowedRequest(request)) return sendJSON(response, 403, errorResult({ code: 'FORBIDDEN' }));
    const raw = request.url || '/';
    if (!raw.startsWith(API)) return next();
    if (request.method !== 'GET') return sendJSON(response, 405, errorResult({ code: 'FORBIDDEN' }));
    try {
      // All supported API paths are literal ASCII. No encoded paths, dot
      // components, fragments, arbitrary file names or alternate URLs exist.
      if (raw.includes('%') || raw.includes('\\') || raw.includes('#') || /[\u0000-\u001f\u007f]/.test(raw)) fail('INVALID_INPUT');
      const url = new URL(raw, PREVIEW_ORIGIN);
      if (url.origin !== PREVIEW_ORIGIN || url.pathname !== raw.split('?')[0]) fail('INVALID_INPUT');
      const index = await loadIndex();
      if (url.pathname === `${API}library` && !url.search) {
        return sendJSON(response, 200, { ok: true, data: { configured: true, root, writable: false,
          revision: index.revision, items: index.items.map(publicItem) } });
      }
      const match = /^\/__preview\/api\/(portraits|images)\/([1-9]\d{0,5})$/.exec(url.pathname);
      if (!match || !idPattern.test(match[2])) fail('INVALID_INPUT');
      const item = index.items.find(candidate => candidate.id === Number(match[2]));
      if (!item) fail('NOT_FOUND');
      if (match[1] === 'portraits') {
        if (url.search) fail('INVALID_INPUT');
        return sendJSON(response, 200, { ok: true, data: { revision: index.revision, item: publicItem(item) } });
      }
      if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1
        || !/^[1-9]\d*$/.test(url.searchParams.get('revision')) || Number(url.searchParams.get('revision')) !== item.revision) fail('CONFLICT');
      const bytes = await read(item.imageRel, MAX_IMAGE);
      if (bytes.length !== item.size || hash(bytes) !== item.sha256 || imageMime(bytes) !== item.mime) fail('CONFLICT');
      response.writeHead(200, { 'Content-Type': item.mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return response.end(bytes);
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'NOT_FOUND' : error.code;
      return sendJSON(response, code === 'NOT_FOUND' ? 404 : 400, errorResult({ code }));
    }
  }
  return { root, middleware };
}

function previewLibraryPlugin() {
  return { name: 'portrait-local-readonly-preview', apply: 'serve',
    async configureServer(server) {
      let service, startupError;
      try { service = await createPreviewLibrary(); } catch (error) { startupError = error; }
      server.middlewares.use((request, response, next) => {
        if (!allowedRequest(request)) return sendJSON(response, 403, errorResult({ code: 'FORBIDDEN' }));
        if (request.method !== 'GET') return sendJSON(response, 405, errorResult({ code: 'FORBIDDEN' }));
        if ((request.url || '').split('?')[0].startsWith('/__open-in-editor')) return sendJSON(response, 403, errorResult({ code: 'FORBIDDEN' }));
        if ((request.url || '').startsWith(API)) {
          if (startupError) return sendJSON(response, 503, errorResult(startupError));
          service.middleware(request, response, next).catch(() => sendJSON(response, 500, errorResult({ code: 'IO_ERROR' })));
          return;
        }
        next();
      });
      // Vite's HMR upgrade bypasses Connect middleware. Apply the same origin
      // boundary to upgrades as to HTTP before its websocket handler runs.
      server.httpServer?.prependListener('upgrade', (request, socket) => { if (!allowedRequest(request)) socket.destroy(); });
    }
  };
}

module.exports = { createPreviewLibrary, previewLibraryPlugin, allowedRequest };
