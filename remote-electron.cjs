'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { RemoteClient, RemoteError, imageMime, LIMITS } = require('./remote-client.cjs');
const { discoverBatchDirectory } = require('./batch-import.cjs');
const { prepareDirectoryUpload, revalidateDirectoryUpload } = require('./remote-source.cjs');
const { createAuthenticationDialog } = require('./auth-dialog.cjs');
const { RECOMMENDED_ENDPOINT, readRemoteConfiguration, writeRemoteConfiguration, canonicalEndpoint } = require('./remote-config.cjs');
const { messageText, errorResult, publicIssue, publicUnpaired } = require('./localization.cjs');

const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIFETIME = 30 * 60 * 1000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new RemoteError(code); };
function payload(value, keys) { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT'); }
function filePin(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function samePin(stat, pin) { return stat.dev === pin.dev && stat.ino === pin.ino && stat.size === pin.size && stat.mtimeMs === pin.mtimeMs && stat.ctimeMs === pin.ctimeMs; }
async function assertRealPath(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(filename) || filename.split(path.sep).some(part => part === '.' || part === '..')) fail('UNSAFE_PATH');
  let current = path.parse(filename).root;
  for (const part of filename.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('UNSAFE_PATH');
    if (current !== filename && !stat.isDirectory()) fail('UNSAFE_PATH');
  }
  if (await fs.realpath(filename) !== filename) fail('UNSAFE_PATH');
}
async function readSelected(filename, expected) {
  await assertRealPath(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > LIMITS.image) fail('INVALID_IMAGE');
    if (expected && !samePin(stat, expected)) fail('SOURCE_CHANGED');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const value = await handle.read(bytes, offset, bytes.length - offset, offset); if (!value.bytesRead) fail('SOURCE_CHANGED'); offset += value.bytesRead; }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length), after = await handle.stat(), current = await fs.lstat(filename);
    if (extra.bytesRead || !samePin(after, filePin(stat)) || !samePin(current, filePin(stat)) || current.isSymbolicLink()) fail('SOURCE_CHANGED');
    await assertRealPath(filename);
    if (expected?.sha256 && sha(bytes) !== expected.sha256) fail('SOURCE_CHANGED');
    return { bytes, ...filePin(stat), sha256: sha(bytes), mime: imageMime(bytes) };
  } finally { await handle.close(); }
}

function createRemoteAdapter({ app, ipcMain, dialog, protocol, nativeImage, BrowserWindow, clipboard, rendererURL, trustedSender,
  remoteClient, baseURL = process.env.PORTRAIT_STUDIO_REMOTE_BASE_URL, authorization = process.env.PORTRAIT_STUDIO_REMOTE_AUTHORIZATION,
  derivedChinesePrompts } = {}) {
  let client = remoteClient, startupError = null, locale = 'zh', generation = 1, busy = false, disposed = false, authentication, authenticationFlight = null;
  const environmentOverride = typeof baseURL === 'string' && Boolean(baseURL);
  let configurationSource = remoteClient ? 'environment' : 'unconfigured', connectionStatus = remoteClient ? 'configured' : 'unconfigured', lastErrorCode = null, connectionEpoch = 0;
  let platformSession = null, sessionTimer = null, initialized = null;
  const images = new Map(), directories = new Map(), previews = new Map(), temporaryDirectories = new Set();
  const text = key => messageText(key, locale);
  function settings() {
    expireSession();
    return { endpoint: client?.connection?.endpoint || '', recommendedEndpoint: RECOMMENDED_ENDPOINT, configured: Boolean(client), source: configurationSource,
      environmentOverride, authorizationProvided: Boolean(client?.connection?.authorizationProvided), status: connectionStatus, lastErrorCode,
      initialized, authentication: platformSession, developmentLoginAllowed: Boolean(!app.isPackaged && client?.connection?.transport === 'loopback-development') };
  }
  function current(captured, serviceClient) { if (disposed || captured !== generation || serviceClient !== client) fail('CONFLICT'); }
  function resetAuthentication() { authentication?.dispose(); authentication = createAuthenticationDialog({ BrowserWindow, ipcMain }); authenticationFlight = null; }
  function service() { if (disposed) fail('REMOTE_UNAVAILABLE'); if (startupError) throw startupError; if (!client) fail('REMOTE_NOT_CONFIGURED'); return client; }
  function decorate(snapshot) {
    return { ...snapshot, remote: true, connection: client.connection, authentication: platformSession,
      items: snapshot.items.map(item => ({ ...item, image_url: `portrait-media://asset/${item.id}?revision=${item.revision}&library=${generation}` })) };
  }
  function prune() {
    for (const map of [images, directories, previews]) for (const [token, value] of map) if (value.generation !== generation || Date.now() - value.created > LIFETIME) {
      map.delete(token);
      if (map === previews && client) client.cancel(value.remoteId).catch(() => {});
    }
  }
  function selected(map, token, code = 'INVALID_BATCH_SELECTION') {
    prune(); if (typeof token !== 'string' || !UUID.test(token) || !map.has(token)) fail(code); return map.get(token);
  }
  async function selectedDirectory(token) {
    const directory = selected(directories, token);
    await assertRealPath(directory.path);
    const stat = await fs.lstat(directory.path);
    if (!stat.isDirectory() || stat.dev !== directory.dev || stat.ino !== directory.ino) fail('SOURCE_CHANGED');
    return directory;
  }
  function validateImage(bytes) {
    imageMime(bytes); const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width > 12000 || size.height > 12000) fail('INVALID_IMAGE');
    return true;
  }
  async function selectedImage(token) {
    const image = selected(images, token, 'INVALID_IMAGE_SELECTION'), value = await readSelected(image.path, image);
    validateImage(value.bytes); return value;
  }
  async function exclusive(action) {
    if (busy) fail('BUSY'); busy = true;
    try { return await action(); } finally { busy = false; }
  }
  function register(channel, count, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event, rendererURL)) return errorResult({ code: 'FORBIDDEN' }, locale);
      const requestedClient = client, captured = generation;
      try { if (args.length !== count) fail('INVALID_INPUT'); return { ok: true, data: await handler(event, ...args) }; }
      catch (error) {
        const stale = !disposed && (requestedClient !== client || captured !== generation);
        const reported = stale ? new RemoteError('CONFLICT') : channel === 'library-connection-login' ? error : authenticationFailure(error, requestedClient);
        return errorResult(reported, locale);
      }
    });
  }
  async function clearSelections(requestedClient = client) {
    const live = [...previews.values()]; previews.clear(); directories.clear(); images.clear();
    if (requestedClient) await Promise.allSettled(live.map(preview => requestedClient.cancel(preview.remoteId)));
  }
  function stopSessionTimer() { if (sessionTimer) clearTimeout(sessionTimer); sessionTimer = null; }
  function dropSession(requestedClient, code, retainOldSession = false) {
    if (disposed || requestedClient !== client) return Promise.resolve();
    const hadAuthority = Boolean(platformSession || images.size || directories.size || previews.size);
    stopSessionTimer(); platformSession = null;
    const released = clearSelections(requestedClient);
    if (hadAuthority) {
      resetAuthentication(); client = requestedClient.withoutSession(); generation++; connectionEpoch++;
    }
    connectionStatus = 'error'; lastErrorCode = code;
    if (!retainOldSession) released.finally(() => requestedClient.clearSession?.()).catch(() => {});
    return released;
  }
  function authenticationFailure(error, requestedClient) {
    if (disposed || requestedClient !== client) return error;
    let reported = error;
    if (platformSession && !requestedClient.sessionMetadata && !['AUTH_REQUIRED', 'SESSION_EXPIRED', 'REMOTE_AUTH_REQUIRED'].includes(error?.code)) {
      reported = new RemoteError(Date.now() >= Date.parse(platformSession.expiresAt) ? 'SESSION_EXPIRED' : 'AUTH_REQUIRED');
    }
    if (['AUTH_REQUIRED', 'SESSION_EXPIRED', 'REMOTE_AUTH_REQUIRED'].includes(reported?.code)) dropSession(requestedClient, reported.code).catch(() => {});
    return reported;
  }
  function expireSession() {
    if (platformSession && Date.now() >= Date.parse(platformSession.expiresAt)) dropSession(client, 'SESSION_EXPIRED').catch(() => {});
  }
  function scheduleSessionExpiry(requestedClient) {
    stopSessionTimer();
    if (!platformSession) return;
    const remaining = Date.parse(platformSession.expiresAt) - Date.now();
    if (remaining <= 0) { dropSession(requestedClient, 'SESSION_EXPIRED').catch(() => {}); return; }
    sessionTimer = setTimeout(() => {
      sessionTimer = null;
      if (disposed || requestedClient !== client || !platformSession) return;
      if (Date.now() >= Date.parse(platformSession.expiresAt)) dropSession(requestedClient, 'SESSION_EXPIRED').catch(() => {});
      else scheduleSessionExpiry(requestedClient);
    }, Math.min(remaining, 0x7fffffff));
    sessionTimer.unref?.();
  }
  function authenticateConnection(event) {
    const requestedClient = service();
    const allowLoopback = !app.isPackaged && requestedClient.connection?.transport === 'loopback-development';
    if (requestedClient.connection?.transport !== 'https' && !allowLoopback) fail('REMOTE_NOT_CONFIGURED');
    if (!authenticationFlight) {
      const captured = generation;
      const flight = (async () => {
        let active = true, pendingCandidate = null;
        const abandoned = new Set();
        const abandon = candidate => {
          if (!candidate || abandoned.has(candidate)) return Promise.resolve();
          abandoned.add(candidate);
          const revocation = candidate.logout(); candidate.clearSession?.();
          return revocation.catch(() => {});
        };
        try {
          const status = await requestedClient.authStatus(); current(captured, requestedClient); initialized = status.initialized;
          if (!initialized) fail('AUTH_NOT_INITIALIZED');
          const result = await authentication.show({ parent: BrowserWindow.fromWebContents(event.sender), locale, endpoint: requestedClient.connection.endpoint, allowLoopback,
            authenticate: async credentials => {
              let candidate;
              try {
                current(captured, requestedClient); if (!active || credentials.username !== 'admin') fail('INVALID_INPUT');
                let result;
                try { result = await requestedClient.login({ username: 'admin', password: credentials.password }); }
                finally { credentials.username = ''; credentials.password = ''; }
                candidate = result.client; pendingCandidate = candidate;
                if (!active) fail('ABORTED'); current(captured, requestedClient);
                const snapshot = await candidate.list();
                if (!active) fail('ABORTED'); current(captured, requestedClient);
                const metadata = candidate.sessionMetadata;
                if (metadata?.kind !== 'platform' || metadata.username !== 'admin' || !Number.isFinite(Date.parse(metadata.expiresAt)) || Date.parse(metadata.expiresAt) <= Date.now()) fail('REMOTE_INVALID_RESPONSE');
                return { client: candidate, snapshot, session: Object.freeze({ kind: 'platform', username: 'admin', expiresAt: metadata.expiresAt }) };
              } catch (error) {
                if (candidate) { await abandon(candidate); if (pendingCandidate === candidate) pendingCandidate = null; }
                if (active && !disposed && captured === generation && requestedClient === client) { connectionStatus = 'error'; lastErrorCode = error.code || 'REMOTE_UNAVAILABLE'; }
                throw error;
              } finally { credentials.username = ''; credentials.password = ''; }
            } });
          if (result.cancelled) return result;
          current(captured, requestedClient); await clearSelections(requestedClient); current(captured, requestedClient);
          if (!result.client.sessionMetadata || Date.now() >= Date.parse(result.session.expiresAt)) fail('SESSION_EXPIRED');
          stopSessionTimer(); client = result.client; platformSession = result.session; pendingCandidate = null;
          generation++; connectionStatus = 'connected'; lastErrorCode = null; scheduleSessionExpiry(client);
          if (requestedClient.sessionMetadata) abandon(requestedClient); else requestedClient.clearSession?.();
          return result.snapshot;
        } catch (error) {
          if (!disposed && captured === generation && requestedClient === client) { connectionStatus = 'error'; lastErrorCode = error.code || 'REMOTE_UNAVAILABLE'; }
          throw error;
        } finally { active = false; if (pendingCandidate) abandon(pendingCandidate); }
      })();
      authenticationFlight = flight;
      flight.finally(() => { if (authenticationFlight === flight) authenticationFlight = null; }).catch(() => {});
    }
    return authenticationFlight;
  }
  async function readSnapshot(event) {
    const requestedClient = service(), captured = generation, requestedEpoch = connectionEpoch;
    try {
      const snapshot = await requestedClient.list(); current(captured, requestedClient);
      connectionStatus = 'connected'; lastErrorCode = null; return snapshot;
    } catch (error) {
      if (disposed || requestedEpoch !== connectionEpoch) fail('CONFLICT');
      current(captured, requestedClient);
      let reported = error;
      if (!platformSession && ['AUTH_REQUIRED', 'REMOTE_AUTH_REQUIRED'].includes(error.code)) {
        try {
          const status = await requestedClient.authStatus(); current(captured, requestedClient); initialized = status.initialized;
          if (!initialized) reported = new RemoteError('AUTH_NOT_INITIALIZED');
        } catch (probeError) { current(captured, requestedClient); reported = probeError; }
      }
      connectionStatus = 'error'; lastErrorCode = reported.code || 'REMOTE_UNAVAILABLE';
      throw reported;
    }
  }
  async function mutate(method, value) {
    payload(value, method === 'remove' ? ['id', 'expectedVersion', 'expectedRevision', 'confirmed'] : ['id', 'label', 'type', 'prompts', 'expectedVersion', 'expectedRevision', 'imageToken']);
    if (method === 'remove' && value.confirmed !== true) fail('CONFIRMATION_REQUIRED');
    return exclusive(async () => {
      const requestedClient = service(), captured = generation;
      const { imageToken, ...metadata } = value;
      const image = method === 'create' || imageToken != null ? await selectedImage(imageToken) : undefined;
      current(captured, requestedClient); const data = await requestedClient.mutate(method, metadata, image);
      current(captured, requestedClient);
      if (imageToken) images.delete(imageToken);
      return decorate(data.snapshot);
    });
  }
  async function mediaResponse(request) {
    const requestedClient = client;
    try {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      const url = new URL(request.url);
      if (url.protocol !== 'portrait-media:' || url.username || url.password || url.port || url.hash) return new Response(null, { status: 403 });
      let bytes, mime; const captured = generation;
      if (url.hostname === 'asset' && /^\/[1-9]\d{0,5}$/.test(url.pathname)) {
        if ([...url.searchParams.keys()].some(key => !['revision', 'library'].includes(key)) || url.searchParams.getAll('revision').length !== 1 || url.searchParams.getAll('library').length !== 1 || url.searchParams.get('library') !== String(generation)) return new Response(null, { status: 403 });
        const revision = url.searchParams.get('revision'); if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) return new Response(null, { status: 403 });
        const data = await requestedClient.get(Number(url.pathname.slice(1))); current(captured, requestedClient);
        if (data.item.revision !== Number(revision)) return new Response(null, { status: 404 });
        bytes = await requestedClient.image(data.item); mime = data.item.mime;
      } else if (url.hostname === 'import' && /^\/[0-9a-f-]{36}$/.test(url.pathname) && !url.search) {
        const image = await selectedImage(url.pathname.slice(1)); bytes = image.bytes; mime = image.mime;
      } else return new Response(null, { status: 403 });
      if (disposed || captured !== generation) return new Response(null, { status: 403 });
      return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) { authenticationFailure(error, requestedClient); return new Response(null, { status: 404 }); }
  }
  async function initialise() {
    if (!client) try {
      let endpoint = baseURL;
      if (environmentOverride) configurationSource = 'environment';
      else { const saved = await readRemoteConfiguration(app.getPath('userData')); if (saved) { endpoint = saved.endpoint; configurationSource = 'saved'; } }
      client = new RemoteClient({ baseURL: endpoint, authorization: environmentOverride ? authorization : undefined, allowLoopback: !app.isPackaged }); connectionStatus = 'configured';
    } catch (error) { startupError = error; lastErrorCode = error.code || 'REMOTE_NOT_CONFIGURED'; connectionStatus = lastErrorCode === 'REMOTE_NOT_CONFIGURED' ? 'unconfigured' : 'error'; }
    authentication = createAuthenticationDialog({ BrowserWindow, ipcMain });
    protocol.handle('portrait-media', mediaResponse);
    register('library-ui-language', 1, (_event, value) => { if (!['zh', 'en'].includes(value)) fail('INVALID_LOCALE'); locale = value; return { locale }; });
    register('library-list', 0, async event => { const snapshot = await readSnapshot(event); if (snapshot.cancelled) fail('REMOTE_AUTH_REQUIRED'); return decorate(snapshot); });
    register('library-get', 1, async (_event, id) => {
      const requestedClient = service(), captured = generation, data = await requestedClient.get(id); current(captured, requestedClient);
      return { ...data, item: { ...data.item, image_url: `portrait-media://asset/${data.item.id}?revision=${data.item.revision}&library=${generation}` } };
    });
    register('library-connection-settings', 0, () => settings());
    register('library-connection-save', 1, (_event, value) => exclusive(async () => {
      payload(value, ['endpoint']); if (environmentOverride) fail('REMOTE_ENVIRONMENT_OVERRIDE');
      const endpoint = canonicalEndpoint(value.endpoint), candidate = new RemoteClient({ baseURL: endpoint });
      resetAuthentication(); const captured = generation;
      await writeRemoteConfiguration(app.getPath('userData'), endpoint);
      if (disposed || captured !== generation) fail('CONFLICT');
      const previousClient = client, oldPreviews = [...previews.values()]; previews.clear(); directories.clear(); images.clear();
      stopSessionTimer(); platformSession = null; initialized = null;
      client = candidate; startupError = null; generation++; connectionEpoch++; configurationSource = 'saved'; connectionStatus = 'configured'; lastErrorCode = null;
      if (previousClient) { await Promise.allSettled(oldPreviews.map(preview => previousClient.cancel(preview.remoteId))); if (previousClient.sessionMetadata) await previousClient.logout().catch(() => {}); previousClient.clearSession?.(); }
      return settings();
    }));
    register('library-connection-login', 0, event => exclusive(async () => {
      const snapshot = await authenticateConnection(event); if (snapshot.cancelled) return snapshot;
      expireSession(); if (!platformSession) fail('SESSION_EXPIRED'); return decorate(snapshot);
    }));
    register('library-connection-logout', 0, () => exclusive(async () => {
      const requestedClient = service(), hadSession = Boolean(platformSession);
      await dropSession(requestedClient, 'AUTH_REQUIRED', true);
      let serverLoggedOut = false, logoutErrorCode = null;
      try { if (hadSession) serverLoggedOut = (await requestedClient.logout()).loggedOut === true; }
      catch (error) { logoutErrorCode = errorResult(error, locale).error.code; }
      finally { requestedClient.clearSession?.(); }
      return { ...settings(), serverLoggedOut, logoutErrorCode };
    }));
    register('library-choose', 0, async event => exclusive(async () => {
      const requestedClient = service(), captured = generation;
      const snapshot = await readSnapshot(event); if (snapshot.cancelled) return snapshot;
      await clearSelections(requestedClient); current(captured, requestedClient); generation++; return decorate(snapshot);
    }));
    register('library-image-choose', 0, event => exclusive(async () => {
      const requestedClient = service(), captured = generation; await requestedClient.list(); current(captured, requestedClient);
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: text('native.imageTitle'), message: text('native.imageMessage'), buttonLabel: text('native.imageButton'), properties: ['openFile'], filters: [{ name: text('native.imageFilter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (result.canceled || result.filePaths.length !== 1) return { cancelled: true };
      const filename = result.filePaths[0], image = await readSelected(filename); validateImage(image.bytes);
      current(captured, requestedClient); prune(); if (images.size >= 64) fail('BUSY');
      const token = randomUUID(); const { bytes, ...pin } = image; images.set(token, { path: filename, ...pin, generation, created: Date.now() });
      return { token, previewURL: `portrait-media://import/${token}`, name: path.basename(filename) };
    }));
    register('library-image-release', 1, (_event, token) => { if (typeof token !== 'string' || !UUID.test(token)) fail('INVALID_IMAGE_SELECTION'); images.delete(token); return { released: true }; });
    register('library-create', 1, (_event, value) => mutate('create', value));
    register('library-update', 1, (_event, value) => mutate('update', value));
    register('library-delete', 1, (_event, value) => mutate('remove', value));
    register('library-batch-directory-choose', 0, event => exclusive(async () => {
      const requestedClient = service(), captured = generation; await requestedClient.list(); current(captured, requestedClient);
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: text('native.batchDirectoryTitle'), message: text('native.batchDirectoryMessage'), buttonLabel: text('native.batchDirectoryButton'), properties: ['openDirectory'] });
      if (result.canceled || result.filePaths.length !== 1) return { cancelled: true };
      const filename = result.filePaths[0], discovery = await discoverBatchDirectory({ directory: filename }), stat = await fs.lstat(filename);
      current(captured, requestedClient);
      prune(); if (directories.size >= 64) fail('BUSY');
      const candidates = new Map(discovery.manifests.map(manifest => [randomUUID(), manifest])), selectionId = randomUUID();
      directories.set(selectionId, { path: discovery.sourceDirectory, dev: stat.dev, ino: stat.ino, discovery, candidates, generation, created: Date.now() });
      return { selectionId, path: discovery.sourceDirectory, name: path.basename(filename), manifests: [...candidates].map(([candidateId, value]) => ({ candidateId, ...value })), imageCount: discovery.imageCount, limits: discovery.limits, ignoredManifests: discovery.ignoredManifests };
    }));
    register('library-batch-preview', 1, (_event, value) => exclusive(async () => {
      payload(value, ['directorySelectionId', 'manifestCandidateId', 'type']); if (!['photo', 'art'].includes(value.type)) fail('INVALID_TYPE');
      const requestedClient = service(), captured = generation;
      const directory = await selectedDirectory(value.directorySelectionId);
      const candidateId = value.manifestCandidateId ?? (directory.candidates.size === 1 ? [...directory.candidates.keys()][0] : null);
      if (!candidateId) fail('MANIFEST_SELECTION_REQUIRED');
      const manifest = typeof candidateId === 'string' && UUID.test(candidateId) ? directory.candidates.get(candidateId) : null;
      if (!manifest) fail('INVALID_BATCH_SELECTION');
      const translations = typeof derivedChinesePrompts === 'function' ? await derivedChinesePrompts({ directory: directory.path, manifestRelativePath: manifest.relativePath }) : undefined;
      const plan = await prepareDirectoryUpload({ directory: directory.path, manifestRelativePath: manifest.relativePath });
      await revalidateDirectoryUpload(plan); current(captured, requestedClient);
      const preview = await requestedClient.preview({ manifestRelativePath: manifest.relativePath, manifestBytes: plan.manifestBytes, type: value.type, images: plan.images, derivedChinesePrompts: translations });
      try {
        await revalidateDirectoryUpload(plan);
        if (disposed || !directories.has(value.directorySelectionId)) fail('INVALID_BATCH_SELECTION');
        if (captured !== generation) fail('CONFLICT'); prune(); if (previews.size >= 64) fail('BUSY');
      }
      catch (error) { await requestedClient.cancel(preview.previewId).catch(() => {}); throw error; }
      const previewId = randomUUID(); previews.set(previewId, { remoteId: preview.previewId, plan, revision: preview.revision, directorySelectionId: value.directorySelectionId, generation, created: Date.now() });
      return { ...preview, previewId, sourceDirectory: directory.path, manifestPath: manifest.relativePath, issues: preview.issues.map(publicIssue), unpaired: preview.unpaired.map(item => publicUnpaired({ ...item, reasonCode: item.reasonCode ?? item.code })) };
    }));
    register('library-batch-commit', 1, (_event, value) => exclusive(async () => {
      payload(value, ['previewId', 'confirmed', 'expectedVersion']); if (value.confirmed !== true) fail('CONFIRMATION_REQUIRED');
      const requestedClient = service(), captured = generation;
      const preview = selected(previews, value.previewId); if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion !== preview.revision) fail('CONFLICT');
      await selectedDirectory(preview.directorySelectionId); await revalidateDirectoryUpload(preview.plan);
      current(captured, requestedClient); const data = await requestedClient.commit(preview.remoteId, { confirmed: true, expectedVersion: value.expectedVersion }); current(captured, requestedClient);
      previews.delete(value.previewId); directories.delete(preview.directorySelectionId);
      return { ...data, snapshot: decorate(data.snapshot) };
    }));
    register('library-batch-cancel', 1, async (_event, value) => {
      payload(value, ['previewId', 'directorySelectionId']); if (Object.values(value).some(token => typeof token !== 'string' || !UUID.test(token))) fail('INVALID_BATCH_SELECTION');
      let released = 0; const cancelled = [];
      for (const [token, preview] of previews) if (token === value.previewId || preview.directorySelectionId === value.directorySelectionId) cancelled.push([token, preview.remoteId]);
      if (value.directorySelectionId && directories.delete(value.directorySelectionId)) released++;
      for (const [token, remoteId] of cancelled) { await service().cancel(remoteId); previews.delete(token); released++; }
      return { released };
    });
    ipcMain.handle('copy-prompt', async (event, value, ...extra) => {
      if (!trustedSender(event, rendererURL)) return false;
      const requestedClient = client;
      try {
        if (extra.length) fail('INVALID_INPUT'); payload(value, ['id', 'revision', 'language']);
        if (!['en', 'zh'].includes(value.language) || !Number.isSafeInteger(value.revision)) fail('INVALID_INPUT');
        const captured = generation, data = await service().get(value.id);
        if (disposed || captured !== generation || data.item.revision !== value.revision) fail('CONFLICT');
        clipboard.writeText(data.item.prompts[value.language]); return true;
      } catch (error) { authenticationFailure(error, requestedClient); return false; }
    });
  }
  async function imageToOpen(value) {
    const requestedClient = client;
    try { return await verifiedImageToOpen(value); }
    catch (error) { throw authenticationFailure(error, requestedClient); }
  }
  async function verifiedImageToOpen(value) {
    payload(value, ['id', 'revision']); const requestedClient = service(), captured = generation, data = await requestedClient.get(value.id); current(captured, requestedClient);
    if (data.item.revision !== value.revision) fail('CONFLICT');
    const bytes = await requestedClient.image(data.item); if (disposed) fail('REMOTE_UNAVAILABLE'); current(captured, requestedClient);
    const directory = await fs.mkdtemp(path.join(app.getPath('temp'), 'portrait-studio-image-'));
    if (disposed || captured !== generation || requestedClient !== client) { await fs.rm(directory, { recursive: true, force: true }); fail('CONFLICT'); }
    temporaryDirectories.add(directory);
    const filename = path.join(directory, `portrait.${({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[data.item.mime]}`);
    try { await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); current(captured, requestedClient); return filename; }
    catch (error) { temporaryDirectories.delete(directory); await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }
  async function dispose() {
    disposed = true; stopSessionTimer(); authentication?.dispose(); await clearSelections(); platformSession = null; client?.clearSession?.();
    await Promise.allSettled([...temporaryDirectories].map(directory => fs.rm(directory, { recursive: true, force: true })));
    temporaryDirectories.clear();
  }
  return { initialise, imageToOpen, dispose };
}

module.exports = { createRemoteAdapter, readSelected };
