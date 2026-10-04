'use strict';

// Vite development preview only. All requests use the fixed remote client;
// this module has no local gallery, filesystem or mutation API.
const { RemoteClient, RemoteError, safeRelativePath } = require('./remote-client.cjs');
const { errorResult } = require('./localization.cjs');

const PREVIEW_ORIGIN = 'http://127.0.0.1:5173';
const PREVIEW_HOST = '127.0.0.1:5173';
const API = '/__preview/api/';
const ROOT_LABEL = 'Server library';
const fail = code => { throw new RemoteError(code); };

function allowedRequest(request) {
  if (request.headers?.host !== PREVIEW_HOST) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== PREVIEW_ORIGIN) return false;
  const site = request.headers['sec-fetch-site'];
  return site === undefined || ['none', 'same-origin', 'same-site'].includes(site);
}
function sendJSON(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  response.end(JSON.stringify(value));
}
function sendError(response, error) {
  const result = errorResult(error), code = result.error.code;
  const status = ['NOT_FOUND', 'REMOTE_ROUTE_MISSING'].includes(code) ? 404 : ['FORBIDDEN', 'REMOTE_FORBIDDEN'].includes(code) ? 403 : code === 'REMOTE_AUTH_REQUIRED' ? 401
    : code === 'REMOTE_TIMEOUT' ? 504 : code === 'CONFLICT' ? 409 : ['REMOTE_NOT_CONFIGURED', 'REMOTE_UNAVAILABLE', 'REMOTE_SERVICE_UNAVAILABLE'].includes(code) ? 503
      : code === 'REMOTE_INVALID_RESPONSE' ? 502 : 400;
  return sendJSON(response, status, result);
}
function publicItem(item) {
  return { id: item.id, label: item.label, type: item.type, prompts: { en: item.prompts.en, zh: item.prompts.zh },
    revision: item.revision, mime: item.mime, size: item.size, sha256: item.sha256,
    ...(typeof item.image === 'string' && safeRelativePath(item.image) && !item.image.includes('/') ? { image: item.image } : {}),
    ...(safeRelativePath(item.imageRel) ? { imageRel: item.imageRel } : {}),
    ...(item.sourceMetadata ? { sourceMetadata: item.sourceMetadata } : {}),
    ...(item.sourceImport ? { sourceImport: item.sourceImport } : {}),
    image_url: `${API}images/${item.id}?revision=${item.revision}` };
}

function createRemotePreview({ baseURL = process.env.PORTRAIT_STUDIO_REMOTE_BASE_URL,
  authorization = process.env.PORTRAIT_STUDIO_REMOTE_AUTHORIZATION, allowLoopback = true, fetchImpl } = {}) {
  const client = new RemoteClient({ baseURL, authorization, allowLoopback, ...(fetchImpl ? { fetchImpl } : {}) });
  async function middleware(request, response, next) {
    if (!allowedRequest(request)) return sendJSON(response, 403, errorResult({ code: 'FORBIDDEN' }));
    if (request.method !== 'GET') return sendJSON(response, 405, errorResult({ code: 'FORBIDDEN' }));
    const raw = request.url || '/';
    if (!raw.startsWith(API)) return next();
    try {
      if (raw.includes('%') || raw.includes('\\') || raw.includes('#') || /[\u0000-\u001f\u007f]/.test(raw)) fail('INVALID_INPUT');
      if (raw === `${API}library`) {
        const snapshot = await client.list();
        return sendJSON(response, 200, { ok: true, data: { configured: true, writable: false, remote: true,
          root: ROOT_LABEL, revision: snapshot.revision, items: snapshot.items.map(publicItem) } });
      }
      const detail = /^\/__preview\/api\/portraits\/([1-9]\d{0,5})$/.exec(raw);
      if (detail) {
        const value = await client.get(Number(detail[1]));
        return sendJSON(response, 200, { ok: true, data: { revision: value.revision, item: publicItem(value.item) } });
      }
      const image = /^\/__preview\/api\/images\/([1-9]\d{0,5})\?revision=([1-9]\d*)$/.exec(raw);
      if (!image || !Number.isSafeInteger(Number(image[2]))) fail('INVALID_INPUT');
      const value = await client.get(Number(image[1]));
      if (value.item.revision !== Number(image[2])) fail('CONFLICT');
      const bytes = await client.image(value.item);
      response.writeHead(200, { 'Content-Type': value.item.mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return response.end(bytes);
    } catch (error) { return sendError(response, error); }
  }
  return { middleware };
}

function remotePreviewPlugin(options) {
  return { name: 'portrait-remote-readonly-preview', apply: 'serve',
    configureServer(server) {
      let service, startupError;
      try { service = createRemotePreview(options); } catch (error) { startupError = error; }
      server.middlewares.use((request, response, next) => {
        if (!allowedRequest(request)) return sendJSON(response, 403, errorResult({ code: 'FORBIDDEN' }));
        if (request.method !== 'GET') return sendJSON(response, 405, errorResult({ code: 'FORBIDDEN' }));
        if ((request.url || '').split('?')[0].startsWith('/__open-in-editor')) return sendJSON(response, 403, errorResult({ code: 'FORBIDDEN' }));
        if ((request.url || '').startsWith(API)) {
          if (startupError) return sendError(response, startupError);
          service.middleware(request, response, next).catch(() => sendError(response, { code: 'REMOTE_UNAVAILABLE' }));
          return;
        }
        next();
      });
      // Vite websocket upgrades bypass Connect's HTTP middleware.
      server.httpServer?.prependListener('upgrade', (request, socket) => { if (!allowedRequest(request)) socket.destroy(); });
    }
  };
}

module.exports = { createRemotePreview, remotePreviewPlugin, previewLibraryPlugin: remotePreviewPlugin, allowedRequest };
