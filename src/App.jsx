import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { portraitNumber, promptFor, labelFor } from './portraits.js';
import { useI18n } from './i18n.jsx';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import Gallery from './components/Gallery.jsx';
import DetailDialog from './components/DetailDialog.jsx';
import PortraitEditor from './components/PortraitEditor.jsx';
import DeleteConfirm from './components/DeleteConfirm.jsx';
import BatchImportDialog from './components/BatchImportDialog.jsx';
import BatchProcessDialog from './components/BatchProcessDialog.jsx';
import Toast from './components/Toast.jsx';
import useFavorites from './useFavorites.js';
import useTags from './useTags.js';
import { tagKey, tagCatalog } from './tags.mjs';
import { TagFilter } from './components/ImageTags.jsx';
import CompareDialog, { CompareTray } from './components/Compare.jsx';
import CreativeLab from './components/CreativeLab.jsx';
import useCreativeDrafts from './useCreativeDrafts.js';
import usePromptPlans from './usePromptPlans.js';
import useGalleryView from './useGalleryView.js';
import { MAX_DRAFT_LENGTH } from './creative-lab.mjs';
import Playground from './components/Playground.jsx';
import RemoteConnectionDialog, { RemoteConnectionContext, recommendedEndpoint, connectionStatusForError, isConnectionError, isAuthenticationError, platformSessionActive } from './components/RemoteConnectionDialog.jsx';

const initialLibrary = { configured: false, root: '', writable: false, revision: null, items: [] };
function unwrap(result) {
  if (result?.ok) return result.data;
  const error = new Error(result?.error?.code || 'UNAVAILABLE');
  error.code = result?.error?.code || 'UNAVAILABLE';
  throw error;
}
export default function App() {
  const { t, errorText, uiLanguage: language } = useI18n();
  const bridge = window.portraitStudio;
  const connected = typeof bridge?.libraryList === 'function';
  const browserPreview = bridge?.mode === 'browser-preview';
  const desktop = connected && !browserPreview;
  const remoteBackend = bridge?.backend === 'remote';
  const connectionSupported = desktop && remoteBackend && ['connectionSettings', 'saveConnection', 'signIn', 'logout'].every(name => typeof bridge?.[name] === 'function');
  const [library, setLibrary] = useState(initialLibrary);
  const [connection, setConnection] = useState({ endpoint: '', recommendedEndpoint, configured: false, environmentOverride: false, authorizationProvided: false, authentication: null, status: 'unconfigured' });
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [pending, setPending] = useState(connected ? 'loading' : '');
  const [query, setQuery] = useState('');
  const { dense, sort, setSort, toggleDensity, storageFailed: viewStorageFailed } = useGalleryView();
  const [selectedId, setSelectedId] = useState(null);
  const [detailItem, setDetailItem] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [toast, setToast] = useState('');
  const [editor, setEditor] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [comparisonSelection, setComparisonSelection] = useState({ scope: null, ids: [] });
  const [comparisonItems, setComparisonItems] = useState(null);
  const [creativeSession, setCreativeSession] = useState(null);
  const [playSession, setPlaySession] = useState(null);
  const [playFeedback, setPlayFeedback] = useState(null);
  const playSessionRef = useRef(null);
  playSessionRef.current = playSession;
  const playSequence = useRef(0);
  const creativeSequence = useRef(0);
  const searchRef = useRef(null);
  const timers = useRef({});
  const busyRef = useRef(connected);
  const selectionRequest = useRef(0);
  const editorSession = useRef(0);
  const lastRandomId = useRef(null);
  const items = library.configured ? library.items : initialLibrary.items;
  const favoriteScope = library.configured && library.root && (!remoteBackend || connection.endpoint)
    ? JSON.stringify([remoteBackend ? 'remote' : 'local', remoteBackend ? connection.endpoint : '', library.root]) : null;
  const { favoriteIds, toggleFavorite, storageFailed } = useFavorites(favoriteScope, items);
  const { tagsById, setTags, storageFailed: tagsStorageFailed } = useTags(favoriteScope, items);
  const { drafts: creativeDrafts, setDraft: setCreativeDraft, setDrafts: setCreativeDrafts, storageFailed: creativeStorageFailed } = useCreativeDrafts(favoriteScope);
  const { plans, savePlan, renamePlan, removePlan, storageFailed: plansStorageFailed } = usePromptPlans(favoriteScope);
  const catalog = useMemo(() => tagCatalog(items, tagsById), [items, tagsById]);
  const [tagFilter, setTagFilter] = useState({ scope: null, value: '' });
  const activeTag = tagFilter.scope === favoriteScope ? tagFilter.value : '';
  const comparisonIds = comparisonSelection.scope === favoriteScope ? comparisonSelection.ids : [];
  const comparisonCandidates = comparisonIds.map(id => items.find(item => item.id === id)).filter(Boolean);
  const [favoriteView, setFavoriteView] = useState({ scope: null, only: false });
  const favoritesOnly = favoriteView.scope === favoriteScope && favoriteView.only;
  const favoriteCount = items.filter(item => favoriteIds.has(item.id)).length;
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = items.filter(item => (!favoritesOnly || favoriteIds.has(item.id)) && (!activeTag || (tagsById[item.id] ?? []).some(name => tagKey(name) === activeTag)) && (!term || [item.id, item.label, item.image, item.prompts?.en, item.prompts?.zh, item.sourceMetadata?.label_en, item.sourceMetadata?.label_cn, item.sourceMetadata?.style_tag_en, item.sourceMetadata?.style_tag_cn, ...(tagsById[item.id] ?? [])].filter(value => value != null).join(' ').toLowerCase().includes(term)));
    if (sort === 'number-desc') filtered.sort((a, b) => b.id - a.id);
    else if (sort === 'name-asc') {
      const collator = new Intl.Collator(language === 'zh' ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
      filtered.sort((a, b) => collator.compare(labelFor(a, language), labelFor(b, language)) || a.id - b.id);
    }
    return filtered;
  }, [items, query, favoritesOnly, favoriteIds, activeTag, tagsById, sort, language]);
  const selected = detailItem?.id === selectedId ? detailItem : null;
  const managing = Boolean(editor || deleteTarget || batchOpen || processOpen || connectionOpen || comparisonItems || creativeSession || playSession);
  const canCompare = connected && library.configured && !libraryError;
  const canCreateDraft = connected && library.configured && Boolean(favoriteScope) && !libraryError;
  const canManage = desktop && library.configured && library.writable && !libraryError && (!remoteBackend || connection.status === 'connected' && platformSessionActive(connection.authentication));
  const canBatchDelete = browserPreview
    ? library.configured && !libraryError && typeof bridge?.deletePortrait === 'function'
    : canManage && typeof bridge?.[remoteBackend ? 'deletePortrait' : 'deletePortraits'] === 'function';
  const showToast = useCallback(message => {
    if (remoteBackend && isConnectionError(message)) {
      setConnection(previous => ({ ...previous, ...(isAuthenticationError(message) ? { authentication: null } : {}), status: connectionStatusForError(message) }));
      setLibrary(initialLibrary); setLibraryError(message);
      selectionRequest.current += 1; setSelectedId(null); setDetailItem(null);
      if (isAuthenticationError(message)) { setEditor(null); setDeleteTarget(null); setBatchOpen(false); }
    }
    setToast(message);
    clearTimeout(timers.current.toast);
    timers.current.toast = setTimeout(() => setToast(''), ['app.batchDeletePartial', 'favorites.sessionOnly', 'tags.sessionOnly', 'lab.sessionOnly', 'browse.sessionOnly'].includes(message?.key) ? 6500 : 2600);
  }, [remoteBackend]);
  useEffect(() => { if (storageFailed) showToast({ key: 'favorites.sessionOnly' }); }, [storageFailed, showToast]);
  useEffect(() => { if (tagsStorageFailed) showToast({ key: 'tags.sessionOnly' }); }, [tagsStorageFailed, showToast]);
  useEffect(() => { if (creativeStorageFailed) showToast({ key: 'lab.sessionOnly' }); }, [creativeStorageFailed, showToast]);
  useEffect(() => { if (viewStorageFailed) showToast({ key: 'browse.sessionOnly' }); }, [viewStorageFailed, showToast]);
  useEffect(() => {
    lastRandomId.current = null;
    setFavoriteView({ scope: favoriteScope, only: false }); setTagFilter({ scope: favoriteScope, value: '' });
    setComparisonSelection({ scope: favoriteScope, ids: [] }); setComparisonItems(null);
    setCreativeSession(null); setPlaySession(null); setPlayFeedback(null);
  }, [favoriteScope, library.root]);
  const applySnapshot = useCallback(snapshot => {
    if (remoteBackend && snapshot.authentication && !platformSessionActive(snapshot.authentication)) {
      setLibrary(initialLibrary); setLibraryError({ code: 'SESSION_EXPIRED' });
      setConnection(previous => ({ ...previous, authentication: null, status: 'session-expired' }));
      setDetailItem(null); setSelectedId(null); return;
    }
    setLibrary(snapshot);
    setLibraryError('');
    setConnection(previous => ({ ...previous, ...(Object.hasOwn(snapshot, 'authentication') ? { authentication: snapshot.authentication } : {}), ...(snapshot.authentication ? { serverLoggedOut: undefined, logoutErrorCode: null } : {}), status: snapshot.configured ? 'connected' : previous.configured ? 'not-connected' : 'unconfigured' }));
    if (snapshot.configured) setDetailItem(previous => previous ? snapshot.items.find(item => item.id === previous.id) ?? null : null);
  }, [remoteBackend]);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const metadata = connectionSupported ? bridge.connectionSettings().then(unwrap) : Promise.resolve(null);
    Promise.allSettled([metadata, bridge.libraryList().then(unwrap)]).then(results => {
      if (!live) return;
      if (results[0].status === 'fulfilled' && results[0].value) {
        const settings = results[0].value;
        setConnection(previous => ({ ...previous, ...settings, status: settings.configured ? 'not-connected' : 'unconfigured' }));
      }
      if (results[1].status === 'fulfilled') applySnapshot(results[1].value);
      else {
        setLibrary(initialLibrary); setLibraryError(results[1].reason);
        setConnection(previous => ({ ...previous, ...(isAuthenticationError(results[1].reason) ? { authentication: null } : {}), status: connectionStatusForError(results[1].reason) }));
      }
    }).finally(() => {
      if (live) { busyRef.current = false; setPending(''); }
    });
    return () => { live = false; };
  }, [connected, bridge, connectionSupported, applySnapshot]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  useEffect(() => { setSelectedIds(new Set()); setSelectionMode(false); }, [library.root]);
  useEffect(() => {
    const available = new Set(items.map(item => item.id));
    setSelectedIds(previous => [...previous].every(id => available.has(id)) ? previous : new Set([...previous].filter(id => available.has(id))));
    setComparisonSelection(previous => previous.ids.every(id => available.has(id)) ? previous : { ...previous, ids: previous.ids.filter(id => available.has(id)) });
  }, [items]);
  useEffect(() => { if (!canBatchDelete) { setSelectionMode(false); setSelectedIds(new Set()); } }, [canBatchDelete]);
  useEffect(() => {
    if (!remoteBackend || !connection.authentication) return;
    const expiresAt = Date.parse(connection.authentication.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    let timer;
    function checkExpiry() {
      const remaining = expiresAt - Date.now();
      if (remaining > 0) { timer = setTimeout(checkExpiry, Math.min(remaining, 2147483647)); return; }
      setConnection(previous => ({ ...previous, authentication: null, status: 'session-expired' }));
      setLibrary(initialLibrary); setLibraryError({ code: 'SESSION_EXPIRED' });
      selectionRequest.current += 1; setSelectedId(null); setDetailItem(null);
      setEditor(null); setDeleteTarget(null); setBatchOpen(false);
    }
    checkExpiry();
    return () => clearTimeout(timer);
  }, [connection.authentication, remoteBackend]);
  async function exclusive(kind, action) {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(kind);
    try { return await action(); }
    finally { busyRef.current = false; setPending(''); }
  }
  async function readSnapshot() {
    const snapshot = unwrap(await bridge.libraryList());
    applySnapshot(snapshot);
    return snapshot;
  }
  async function updateAuthenticationAfterBooleanFailure() {
    if (!connectionSupported) return false;
    try {
      const settings = unwrap(await bridge.connectionSettings());
      const error = { code: settings.lastErrorCode };
      if (!settings.authentication && isAuthenticationError(error)) {
        setConnection(previous => ({ ...previous, ...settings, authentication: null, status: connectionStatusForError(error) }));
        showToast(error); return true;
      }
    } catch (error) { if (isAuthenticationError(error)) { showToast(error); return true; } }
    return false;
  }
  function closeDetail() { selectionRequest.current += 1; setSelectedId(null); setDetailItem(null); }
  async function configureLibrary() {
    if (!desktop || managing) return;
    if (connectionSupported) { setConnectionOpen(true); return; }
    await exclusive('configure', async () => {
      try {
        const data = unwrap(await bridge.chooseLibrary());
        if (data.cancelled) return;
        closeDetail();
        applySnapshot(data);
        setQuery('');
        showToast({ key: data.writable ? 'app.connected' : 'app.connectedReadonly' });
      } catch (error) { setLibraryError(error); showToast(error); }
    });
  }
  function openConnectionSettings() {
    if (!connectionSupported || managing || busyRef.current) return;
    setConnectionOpen(true);
  }
  async function connectServer(endpoint) {
    if (!connectionSupported || busyRef.current) return;
    await exclusive('connect', async () => {
      closeDetail(); setLibrary(initialLibrary); setLibraryError('');
      setConnection(previous => ({ ...previous, status: 'connecting' }));
      try {
        if (endpoint !== connection.endpoint || !connection.configured) {
          const settings = unwrap(await bridge.saveConnection({ endpoint }));
          setConnection(previous => ({ ...previous, ...settings, status: 'connecting' }));
        }
        const snapshot = unwrap(await bridge.chooseLibrary());
        if (snapshot.cancelled) throw { code: 'REMOTE_AUTH_REQUIRED' };
        applySnapshot(snapshot); setQuery('');
        showToast({ key: snapshot.writable ? 'app.connected' : 'app.connectedReadonly' });
      } catch (error) {
        setLibraryError(error); setConnection(previous => ({ ...previous, status: connectionStatusForError(error) }));
        showToast(error);
      }
    });
  }
  async function signInServer() {
    if (!connectionSupported || busyRef.current) return;
    await exclusive('login', async () => {
      try {
        const result = unwrap(await bridge.signIn());
        if (result.cancelled) return;
        closeDetail(); applySnapshot(result); setQuery('');
        showToast({ key: result.writable ? 'app.connected' : 'app.connectedReadonly' });
      } catch (error) {
        setLibraryError(error); setConnection(previous => ({ ...previous, status: connectionStatusForError(error) }));
        showToast(error);
      }
    });
  }
  async function signOutServer() {
    if (!connectionSupported || typeof bridge.logout !== 'function' || busyRef.current) return;
    await exclusive('logout', async () => {
      try {
        const settings = unwrap(await bridge.logout());
        closeDetail(); setLibrary(initialLibrary); setLibraryError({ code: 'AUTH_REQUIRED' });
        setEditor(null); setDeleteTarget(null); setBatchOpen(false); setQuery('');
        setConnection(previous => ({ ...previous, ...settings, authentication: null, status: 'auth-required' }));
        showToast({ key: settings.serverLoggedOut === false ? 'connection.signedOutUnconfirmed' : 'connection.signedOut' });
      } catch (error) { showToast(error); }
    });
  }
  async function refreshLibrary() {
    if (!connected || managing) return;
    await exclusive('refresh', async () => {
      try { await readSnapshot(); showToast({ key: 'app.refreshed' }); }
      catch (error) { setLibraryError(error); showToast(error); }
    });
  }
  async function openDetail(id) {
    if (busyRef.current || managing || selectionMode) return;
    const request = ++selectionRequest.current;
    try {
      const item = library.configured ? unwrap(await bridge.libraryGet(id)).item : items.find(value => value.id === id);
      if (request === selectionRequest.current && item) { setSelectedId(id); setDetailItem(item); }
    } catch (error) { if (request === selectionRequest.current) showToast(error); }
  }
  useEffect(() => { setCopiedId(null); }, [language]);
  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented) return;
      if (!managing && !pending && selectionMode && event.key === 'Escape') { setSelectionMode(false); setSelectedIds(new Set()); }
      if (!managing && !selectedId && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [managing, pending, selectionMode, selectedId]);
  async function copyPrompt(item, fromCard = false) {
    if (!item) return false;
    try {
      if (desktop) {
        if (typeof bridge.copyPrompt !== 'function' || !await bridge.copyPrompt({ id: item.id, revision: item.revision, language })) throw new Error('COPY_FAILED');
      } else {
        const prompt = promptFor(item, language);
        const copied = await bridge?.copyText(prompt);
        if (!copied) await navigator.clipboard.writeText(prompt);
      }
      if (fromCard) {
        setCopiedId(item.id);
        clearTimeout(timers.current.copy);
        timers.current.copy = setTimeout(() => setCopiedId(null), 1500);
      }
      showToast({ key: 'app.promptCopied', params: { number: portraitNumber(item), languageKey: language === 'zh' ? 'app.chinese' : 'app.english' } });
      return true;
    } catch { if (!await updateAuthenticationAfterBooleanFailure()) showToast({ key: 'app.copyFailed' }); return false; }
  }
  async function openImage(item) {
    if (!item) return;
    try {
      if (bridge) {
        const target = library.configured ? { id: item.id, revision: item.revision } : item.image;
        if (!await bridge.openImage(target) && !await updateAuthenticationAfterBooleanFailure()) showToast({ key: 'app.imageFailed' });
      } else { window.open(item.image_url, '_blank', 'noopener,noreferrer'); }
    } catch { if (!await updateAuthenticationAfterBooleanFailure()) showToast({ key: 'app.imageFailed' }); }
  }
  function cycle(direction) {
    if (!selected || !visible.length || managing) return;
    const index = visible.findIndex(item => item.id === selected.id);
    const nextIndex = index < 0 ? (direction > 0 ? 0 : visible.length - 1) : (index + direction + visible.length) % visible.length;
    openDetail(visible[nextIndex].id);
  }
  function openRandom() {
    if (busyRef.current || managing || selectionMode || !visible.length) return;
    const previousId = selected?.id ?? lastRandomId.current;
    const alternatives = visible.filter(item => item.id !== previousId);
    const pool = alternatives.length ? alternatives : visible;
    const next = pool[Math.floor(Math.random() * pool.length)];
    lastRandomId.current = next.id;
    openDetail(next.id);
  }
  function changeFavoriteView(only) {
    if (busyRef.current || managing) return;
    setFavoriteView({ scope: favoriteScope, only });
  }
  function toggleItemFavorite(id) {
    if (busyRef.current || libraryError || !favoriteScope || selectionMode || managing) return;
    toggleFavorite(id);
  }
  function saveItemTags(id, names) {
    if (busyRef.current || libraryError || !favoriteScope || managing) return;
    setTags(id, names);
  }
  function changeTagFilter(value) {
    if (busyRef.current || managing) return;
    setTagFilter({ scope: favoriteScope, value });
  }
  function resetFilters() {
    if (busyRef.current || managing) return;
    setQuery(''); setTagFilter({ scope: favoriteScope, value: '' }); setFavoriteView({ scope: favoriteScope, only: false });
  }
  function toggleComparison(id) {
    if (busyRef.current || managing || selectionMode || !canCompare || !items.some(item => item.id === id)) return;
    if (!comparisonIds.includes(id) && comparisonIds.length >= 4) { showToast({ key: 'compare.limit' }); return; }
    setComparisonSelection(previous => {
      const ids = previous.scope === favoriteScope ? previous.ids : [];
      return { scope: favoriteScope, ids: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id].slice(0, 4) };
    });
  }
  function clearComparison() {
    if (!busyRef.current && !managing && !selectionMode) setComparisonSelection({ scope: favoriteScope, ids: [] });
  }
  async function openComparison() {
    if (!canCompare || comparisonCandidates.length < 2 || busyRef.current || managing || selectionMode) return;
    await exclusive('compare', async () => {
      try {
        const snapshot = await readSnapshot();
        const available = new Set(snapshot.items.map(item => item.id));
        if (comparisonCandidates.some(item => !available.has(item.id))) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        const current = [];
        for (const item of comparisonCandidates) current.push(unwrap(await bridge.libraryGet(item.id)).item);
        closeDetail(); setComparisonItems(current);
      } catch (error) { showToast(error); }
    });
  }
  async function readCreativeSources(ids) {
    const snapshot = await readSnapshot();
    const available = new Set(snapshot.items.map(item => item.id));
    if (ids.some(id => !available.has(id))) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    const sources = [];
    for (const id of ids) sources.push(unwrap(await bridge.libraryGet(id)).item);
    return sources;
  }
  async function openPlayground() {
    if (!canCreateDraft || busyRef.current || managing || selectionMode || !visible.length) return;
    const ids = visible.map(item => item.id);
    await exclusive('playground', async () => {
      try {
        const snapshot = await readSnapshot();
        const byId = new Map(snapshot.items.map(item => [item.id, item]));
        const candidates = ids.map(id => byId.get(id)).filter(Boolean);
        if (!candidates.length) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        closeDetail();
        setPlayFeedback(null);
        setPlaySession({ id: ++playSequence.current, scope: favoriteScope, items: candidates });
      } catch (error) { showToast(error); }
    });
  }
  function togglePlaygroundFavorite(id) {
    if (!playSession || playSession.scope !== favoriteScope || busyRef.current || libraryError || !playSession.items.some(item => item.id === id)) return;
    setPlayFeedback(null);
    toggleFavorite(id);
  }
  async function openPlaygroundDetail(item) {
    if (!playSession || playSession.scope !== favoriteScope || busyRef.current || !playSession.items.some(candidate => candidate.id === item?.id)) return;
    await exclusive('play-detail', async () => {
      try {
        setPlayFeedback(null);
        await readSnapshot();
        const current = unwrap(await bridge.libraryGet(item.id)).item;
        closeDetail(); setPlaySession(null); setSelectedId(current.id); setDetailItem(current);
      } catch (error) { setPlayFeedback({ error: true, value: error }); showToast(error); }
    });
  }
  async function refreshPlaygroundImage(item) {
    if (!playSession || playSession.scope !== favoriteScope || busyRef.current || !playSession.items.some(candidate => candidate.id === item?.id)) return false;
    const sessionId = playSession.id;
    return await exclusive('play-image', async () => {
      try {
        setPlayFeedback(null);
        await readSnapshot();
        const current = unwrap(await bridge.libraryGet(item.id)).item;
        setPlaySession(previous => previous?.id === sessionId ? { ...previous, items: previous.items.map(candidate => candidate.id === current.id ? current : candidate) } : previous);
        return true;
      } catch (error) { setPlayFeedback({ error: true, value: error }); showToast(error); return false; }
    });
  }
  async function copyPlaygroundPrompt(item) {
    if (!playSession || busyRef.current || !playSession.items.some(candidate => candidate.id === item?.id)) return;
    const sessionId = playSession.id;
    const success = await copyPrompt(item);
    if (playSessionRef.current?.id !== sessionId) return;
    setPlayFeedback({ error: !success, value: { key: success ? 'common.copied' : 'app.copyFailed' } });
  }
  function remixPlaygroundItem(item) {
    if (!playSession || playSession.scope !== favoriteScope || !playSession.items.some(candidate => candidate.id === item?.id)) return;
    openCreativeLab([item.id]);
  }
  async function openCreativeLab(seedIds) {
    if (!canCreateDraft || busyRef.current || selectionMode || editor || deleteTarget || batchOpen || processOpen || connectionOpen || creativeSession) return;
    let ids;
    if (Array.isArray(seedIds)) ids = [...new Set(seedIds)].slice(0, 4);
    else if (comparisonCandidates.length) ids = comparisonCandidates.map(item => item.id);
    else {
      const pool = [...visible]; ids = [];
      while (pool.length && ids.length < 3) ids.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].id);
    }
    await exclusive('creative', async () => {
      try {
        if (playSession) setPlayFeedback(null);
        const sources = await readCreativeSources(ids);
        closeDetail(); setComparisonItems(null); setPlaySession(null);
        setCreativeSession({ id: ++creativeSequence.current, scope: favoriteScope, sources });
      } catch (error) { if (playSession) setPlayFeedback({ error: true, value: error }); showToast(error); }
    });
  }
  async function changeCreativeSources(ids) {
    if (!creativeSession || !canCreateDraft || busyRef.current || !Array.isArray(ids)) return;
    const unique = [...new Set(ids)];
    if (unique.length > 4) { showToast({ key: 'lab.sourceLimit' }); return; }
    if (unique.some(id => !Number.isInteger(id))) return;
    const sessionId = creativeSession.id;
    await exclusive('creative-source', async () => {
      try {
        const sources = await readCreativeSources(unique);
        setCreativeSession(previous => previous?.id === sessionId ? { ...previous, sources } : previous);
      } catch (error) { showToast(error); }
    });
  }
  function updateCreativeDraft(draftLanguage, text) {
    if (!creativeSession || creativeSession.scope !== favoriteScope || !canCreateDraft || busyRef.current) return { error: 'lab.unavailable' };
    return setCreativeDraft(draftLanguage, text);
  }
  function updateCreativeDrafts(drafts) {
    if (!creativeSession || creativeSession.scope !== favoriteScope || !canCreateDraft || busyRef.current) return { error: 'lab.unavailable' };
    return setCreativeDrafts(drafts);
  }
  function canChangePlans() {
    return creativeSession && creativeSession.scope === favoriteScope && canCreateDraft && !busyRef.current;
  }
  function saveCreativePlan(title) {
    if (!canChangePlans()) return { ok: false, error: 'plans.unavailable' };
    return savePlan({ title, drafts: creativeDrafts });
  }
  function renameCreativePlan(id, title) {
    if (!canChangePlans()) return { ok: false, error: 'plans.unavailable' };
    return renamePlan(id, title);
  }
  function removeCreativePlan(id) {
    if (!canChangePlans()) return { ok: false, error: 'plans.unavailable' };
    return removePlan(id);
  }
  function restoreCreativePlan(plan) {
    if (!canChangePlans()) return { ok: false, error: 'plans.unavailable' };
    const saved = plans.find(candidate => candidate.id === plan?.id);
    if (!saved) return { ok: false, error: 'plans.notFound' };
    const result = setCreativeDrafts(saved.drafts);
    return result.error ? { ok: false, error: result.error } : { ok: true };
  }
  async function copyCreativeDraft(text) {
    if (!creativeSession || creativeSession.scope !== favoriteScope || !canCreateDraft || busyRef.current || typeof text !== 'string' || !text.trim()) return false;
    if (text.length > MAX_DRAFT_LENGTH) { showToast({ key: 'lab.tooLong', params: { max: MAX_DRAFT_LENGTH } }); return false; }
    try {
      const copied = typeof bridge?.copyText === 'function' ? await bridge.copyText(text) : false;
      if (!copied) throw new Error('COPY_FAILED');
      showToast({ key: 'lab.copied' });
      return true;
    } catch { showToast({ key: 'lab.copyFailed' }); return false; }
  }
  function beginCreate() {
    if (!canManage || busyRef.current) return;
    const used = new Set(items.map(item => item.id));
    let nextId = items.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1;
    if (nextId > 999999) { nextId = 1; while (used.has(nextId) && nextId < 999999) nextId += 1; }
    setEditor({ session: ++editorSession.current, mode: 'create', nextId, version: library.revision, item: null, image: null, error: '', conflict: null });
  }
  async function beginEdit(item) {
    if (!canManage || busyRef.current) return;
    await exclusive('read', async () => {
      try {
        const current = unwrap(await bridge.libraryGet(item.id)).item;
        setDetailItem(current);
        setEditor({ session: ++editorSession.current, mode: 'edit', version: library.revision, item: current, itemRevision: current.revision, image: null, error: '', conflict: null });
      } catch (error) { showToast(error); }
    });
  }
  async function releaseSelection(token) {
    if (!token) return;
    try { unwrap(await bridge.releaseImage(token)); }
    catch (error) { showToast(isAuthenticationError(error) ? error : { key: 'app.releaseFailed', params: { error } }); }
  }
  async function cancelEditor() {
    if (busyRef.current || !editor) return;
    const token = editor.image?.token;
    setEditor(null);
    await releaseSelection(token);
  }
  async function chooseEditorImage() {
    if (!editor) return;
    const session = editor.session;
    await exclusive('image', async () => {
      try {
        const data = unwrap(await bridge.chooseImage());
        if (!data.cancelled) {
          setEditor(previous => previous?.session === session ? { ...previous, image: data, error: '' } : previous);
          if (editor.image?.token !== data.token) await releaseSelection(editor.image?.token);
        }
      } catch (error) {
        if (isAuthenticationError(error)) { showToast(error); return; }
        setEditor(previous => previous?.session === session ? { ...previous, error: error } : previous);
      }
    });
  }
  async function saveEditor(draft) {
    if (!editor || editor.conflict || !canManage) return;
    if (!draft.label.trim() || !draft.prompts.en.trim() || !draft.prompts.zh.trim()) { setEditor(previous => ({ ...previous, error: { key: 'app.requiredFields' } })); return; }
    if (editor.mode === 'create' && !editor.image) { setEditor(previous => ({ ...previous, error: { key: 'app.chooseImageFirst' } })); return; }
    const session = editor.session;
    await exclusive('save', async () => {
      try {
        const payload = { ...draft, expectedVersion: editor.version, ...(editor.image ? { imageToken: editor.image.token } : {}), ...(editor.mode === 'edit' ? { expectedRevision: editor.itemRevision } : {}) };
        const snapshot = unwrap(await (editor.mode === 'edit' ? bridge.updatePortrait(payload) : bridge.createPortrait(payload)));
        applySnapshot(snapshot);
        setEditor(null);
        await releaseSelection(editor.image?.token);
        if (editor.mode === 'create') { setQuery(''); }
        showToast({ key: editor.mode === 'edit' ? 'app.edited' : 'app.created' });
      } catch (error) {
        if (isAuthenticationError(error)) { showToast(error); return; }
        let conflict = null;
        if (error.code === 'CONFLICT') {
          try { const snapshot = await readSnapshot(); conflict = { ...snapshot, item: snapshot.items.find(item => item.id === editor.item?.id) }; }
          catch (refreshError) { setLibraryError(refreshError); if (isAuthenticationError(refreshError)) { showToast(refreshError); return; } }
        }
        setEditor(previous => previous?.session === session ? { ...previous, error: error.code === 'CONFLICT' ? { key: 'app.editConflict' } : error, conflict, reviewOpen: false } : previous);
      }
    });
  }
  function acknowledgeConflict() {
    setEditor(previous => previous?.conflict ? { ...previous, version: previous.conflict.revision, item: previous.conflict.item ?? previous.item, itemRevision: previous.conflict.item?.revision, conflict: null, reviewOpen: false, error: '' } : previous);
  }
  function toggleSelect(id) {
    if (!canBatchDelete || !selectionMode || busyRef.current || managing) return;
    setSelectedIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function beginSelection() {
    if (!canBatchDelete || busyRef.current || managing || !items.length) return;
    closeDetail(); setSelectionMode(true);
  }
  function endSelection() {
    if (busyRef.current || managing) return;
    setSelectedIds(new Set()); setSelectionMode(false);
  }
  function toggleVisibleSelection() {
    if (!canBatchDelete || !selectionMode || busyRef.current || managing) return;
    setSelectedIds(previous => {
      const next = new Set(previous), allSelected = visible.every(item => previous.has(item.id));
      visible.forEach(item => { if (allSelected) next.delete(item.id); else next.add(item.id); });
      return next;
    });
  }
  function beginBatchDelete() {
    if (!canBatchDelete || selectedIds.size === 0 || busyRef.current || managing) return;
    const selection = items.filter(item => selectedIds.has(item.id)).map(item => ({ id: item.id, expectedRevision: item.revision }));
    if (!selection.length) return;
    setDeleteTarget({ count: selection.length, ids: selection.map(item => item.id), items: selection, version: library.revision, preview: browserPreview, error: '', conflicted: false });
  }

  async function beginDelete(item) {
    if (!canManage || busyRef.current) return;
    await exclusive('read', async () => {
      try {
        const current = unwrap(await bridge.libraryGet(item.id)).item;
        setDetailItem(current);
        setDeleteTarget({ item: current, version: library.revision, error: '', conflicted: false });
      } catch (error) { showToast(error); }
    });
  }
  async function confirmDelete() {
    if (!deleteTarget || deleteTarget.conflicted || (deleteTarget.ids ? !canBatchDelete : !canManage)) return;
    if (deleteTarget.ids) {
      await exclusive('delete', async () => {
        try {
          let result;
          if (desktop && !remoteBackend) {
            result = unwrap(await bridge.deletePortraits({ items: deleteTarget.items, expectedVersion: deleteTarget.version, confirmed: true }));
          } else {
            // The retained remote API and preview use their existing fixed route.
            let snapshot = library, errorCode = null;
            const deletedIds = [];
            for (const item of deleteTarget.items) {
              try {
                snapshot = unwrap(await bridge.deletePortrait(browserPreview ? { id: item.id } : { ...item, expectedVersion: snapshot.revision, confirmed: true }));
                deletedIds.push(item.id);
              } catch (error) {
                if (isAuthenticationError(error)) throw error;
                errorCode = error.code || 'IO_ERROR';
                snapshot = await readSnapshot();
                break;
              }
            }
            result = { snapshot, report: { deletedIds, remainingIds: deleteTarget.ids.filter(id => !deletedIds.includes(id)), errorCode } };
          }
          applySnapshot(result.snapshot);
          closeDetail(); setDeleteTarget(null);
          const { deletedIds, remainingIds, errorCode } = result.report;
          setSelectedIds(new Set(remainingIds));
          if (!remainingIds.length) {
            setSelectionMode(false);
            showToast({ key: browserPreview ? 'app.batchPreviewDeleted' : 'app.batchDeleted', params: { count: deletedIds.length } });
          } else {
            showToast({ key: 'app.batchDeletePartial', params: { deleted: deletedIds.length, remaining: remainingIds.length, error: { code: errorCode } } });
          }
        } catch (error) {
          if (isAuthenticationError(error)) { showToast(error); return; }
          const conflicted = ['CONFLICT', 'NOT_FOUND', 'RECOVERY_CONFLICT'].includes(error.code);
          if (conflicted) {
            try { await readSnapshot(); }
            catch (refreshError) { setLibraryError(refreshError); showToast(refreshError); }
          }
          setDeleteTarget(previous => previous ? { ...previous, error: conflicted ? { key: 'app.batchDeleteConflict' } : error, conflicted } : previous);
        }
      });
      return;
    }
    await exclusive('delete', async () => {
      try {
        const snapshot = unwrap(await bridge.deletePortrait({ id: deleteTarget.item.id, expectedVersion: deleteTarget.version, expectedRevision: deleteTarget.item.revision, confirmed: true }));
        closeDetail();
        applySnapshot(snapshot);
        setDeleteTarget(null);
        showToast({ key: 'app.deleted' });
      } catch (error) {
        if (isAuthenticationError(error)) { showToast(error); return; }
        if (error.code === 'CONFLICT') { try { await readSnapshot(); } catch (refreshError) { setLibraryError(refreshError); if (isAuthenticationError(refreshError)) { showToast(refreshError); return; } } }
        setDeleteTarget(previous => previous ? { ...previous, error: error.code === 'CONFLICT' ? { key: 'app.deleteConflict' } : error, conflicted: error.code === 'CONFLICT' } : previous);
      }
    });
  }
  let notice = '';
  const describeError = error => remoteBackend && isConnectionError(error) ? t(`connection.status.${connectionStatusForError(error)}`) : errorText(error);
  if (libraryError) notice = t('app.libraryError', { error: describeError(libraryError) });
  else if (pending === 'loading') notice = t('app.loading');
  else if (!browserPreview) {
    if (!desktop) notice = t('app.desktopRequired');
    else if (!library.configured) notice = t('app.noLibrary');
    else if (!library.writable) notice = t('app.readonly');
  }
  const toastText = toast?.key ? t(toast.key, { ...toast.params, ...(toast.params?.error ? { error: describeError(toast.params.error) } : {}), ...(toast.params?.languageKey ? { language: t(toast.params.languageKey) } : {}) }) : describeError(toast);
  const visibleLibrary = { ...library, writable: desktop ? canManage : library.writable, connected: remoteBackend ? connection.status === 'connected' : library.configured, connectionStatus: remoteBackend ? pending === 'loading' ? 'connecting' : connection.status : undefined };
  const playgroundFeedback = playFeedback ?? (storageFailed ? { error: true, value: { key: 'favorites.sessionOnly' } } : null);
  return <RemoteConnectionContext.Provider value={{ backend: remoteBackend ? 'remote' : 'local', root: library.root, configured: library.configured, allowed: (remoteBackend ? connectionSupported : desktop && typeof bridge?.chooseLibrary === 'function') && !pending && !managing, onOpen: remoteBackend ? openConnectionSettings : configureLibrary, onAuthenticationError: error => { if (remoteBackend && isAuthenticationError(error)) showToast(error); } }}>
    <div className="app-shell"><Sidebar portraits={items} favoriteCount={favoriteCount} favoritesOnly={favoritesOnly} onFavoriteView={changeFavoriteView} favoritesAvailable={Boolean(favoriteScope)} pending={Boolean(pending) || managing} />
      <main className={`main-content${comparisonCandidates.length ? ' has-comparison' : ''}`}>
        <Header query={query} onQuery={setQuery} searchRef={searchRef} batchMode={selectionMode} dense={dense} onToggleDensity={toggleDensity}
          onRandom={openRandom} randomDisabled={Boolean(pending) || managing || selectionMode || !visible.length}
          onCompare={openComparison} compareCount={comparisonCandidates.length} compareDisabled={!canCompare || comparisonCandidates.length < 2 || Boolean(pending) || managing || selectionMode}
          onCreativeLab={() => openCreativeLab()} creativeDisabled={!canCreateDraft || Boolean(pending) || managing || selectionMode}
          onPlayground={openPlayground} playgroundDisabled={!canCreateDraft || Boolean(pending) || managing || selectionMode || !visible.length}
          library={visibleLibrary} desktop={desktop} connected={connected} editable={canManage} pending={Boolean(pending) || managing}
          onConfigure={configureLibrary} onRefresh={refreshLibrary} onCreate={beginCreate}
          onBatch={() => { if (canManage && !busyRef.current && !managing) setBatchOpen(true); }}
          onProcess={() => { if (connected && library.configured && !busyRef.current && !managing) setProcessOpen(true); }}
          canBatchDelete={canBatchDelete && items.length > 0} onSelect={beginSelection} />
        {notice && <div id="libraryNotice" className={`library-notice${libraryError ? ' error' : ''}`} role={libraryError ? 'alert' : 'status'}>{notice}</div>}
        <TagFilter catalog={catalog} value={activeTag} onChange={changeTagFilter} disabled={Boolean(pending) || managing} />
        <Gallery items={visible} dense={dense} copiedId={copiedId} onOpen={openDetail} onCopy={copyPrompt} configured={library.configured} query={query}
          sort={sort} onSort={value => { if (!busyRef.current && !managing) setSort(value); }}
          activeTagName={catalog.find(tag => tag.key === activeTag)?.name ?? activeTag}
          onClearQuery={() => setQuery('')} onClearTag={() => changeTagFilter('')}
          onClearFavorites={() => changeFavoriteView(false)}
          favoriteIds={favoriteIds} favoritesOnly={favoritesOnly} favoritesAvailable={Boolean(favoriteScope) && !libraryError} onToggleFavorite={toggleItemFavorite} onShowAll={() => changeFavoriteView(false)}
          tagFiltered={Boolean(activeTag)} onResetFilters={resetFilters} comparisonIds={comparisonIds} canCompare={canCompare} onToggleCompare={toggleComparison}
          selectedIds={selectedIds} onToggleSelect={toggleSelect} onBatchDelete={beginBatchDelete} batchMode={selectionMode} canBatchDelete={canBatchDelete}
          pending={Boolean(pending) || managing} onBeginSelection={beginSelection} onEndSelection={endSelection} onToggleVisible={toggleVisibleSelection}
          onClearSelection={() => { if (!busyRef.current && !managing) setSelectedIds(new Set()); }} />
      </main>
    </div>
    <CompareTray items={comparisonCandidates} disabled={Boolean(pending) || managing || selectionMode} onRemove={toggleComparison} onClear={clearComparison} onOpen={openComparison} />
    <Toast message={toastText} error={['app.batchDeletePartial', 'favorites.sessionOnly', 'tags.sessionOnly', 'lab.sessionOnly', 'lab.copyFailed', 'lab.tooLong', 'browse.sessionOnly'].includes(toast?.key)} />
    <DetailDialog item={selected} position={selected ? visible.findIndex(item => item.id === selected.id) + 1 : 0} total={visible.length} language={language} onClose={closeDetail} onCopy={copyPrompt} onOpenImage={openImage} onCycle={cycle}
      canManage={canManage} pending={Boolean(pending) || managing} onEdit={beginEdit} onDelete={beginDelete}
      favorite={Boolean(selected && favoriteIds.has(selected.id))} favoritesAvailable={Boolean(favoriteScope) && !libraryError} onToggleFavorite={toggleItemFavorite}
      onRandom={openRandom} randomDisabled={Boolean(pending) || managing || selectionMode || !visible.length}
      tags={selected ? tagsById[selected.id] ?? [] : []} catalog={catalog} onTagsChange={saveItemTags}
      comparing={Boolean(selected && comparisonIds.includes(selected.id))} canCompare={canCompare} onToggleCompare={toggleComparison}
      onCreativeLab={item => openCreativeLab([item.id])} creativeDisabled={!canCreateDraft || Boolean(pending) || managing || selectionMode} />
    <CompareDialog items={comparisonItems} language={language} pending={Boolean(pending)} onClose={() => { if (!busyRef.current) setComparisonItems(null); }} onCopy={copyPrompt} onOpenImage={openImage}
      onCreativeLab={() => openCreativeLab(comparisonItems.map(item => item.id))} />
    <CreativeLab session={creativeSession} items={items} language={language} drafts={creativeDrafts} storageFailed={creativeStorageFailed} onDraftChange={updateCreativeDraft}
      onDraftsChange={updateCreativeDrafts}
      plans={plans} plansStorageFailed={plansStorageFailed} onSavePlan={saveCreativePlan} onRenamePlan={renameCreativePlan} onRemovePlan={removeCreativePlan} onRestorePlan={restoreCreativePlan}
      onSourceIdsChange={changeCreativeSources} pending={Boolean(pending)} onClose={() => { if (!busyRef.current) setCreativeSession(null); }} onCopy={copyCreativeDraft} />
    <Playground session={playSession} language={language} favoriteIds={favoriteIds} pending={Boolean(pending)}
      feedback={playgroundFeedback ? { error: playgroundFeedback.error, text: describeError(playgroundFeedback.value) } : null}
      onClose={() => { if (!busyRef.current) { setPlaySession(null); setPlayFeedback(null); } }} onToggleFavorite={togglePlaygroundFavorite}
      onOpenDetail={openPlaygroundDetail} onCreativeLab={remixPlaygroundItem} onCopy={copyPlaygroundPrompt} onRetryImage={refreshPlaygroundImage} />
    <PortraitEditor editor={editor} pending={Boolean(pending)} saving={pending === 'save'} canSave={canManage} onCancel={cancelEditor} onChooseImage={chooseEditorImage} onSave={saveEditor} onReviewConflict={() => setEditor(previous => ({ ...previous, reviewOpen: true }))} onAcknowledgeConflict={acknowledgeConflict} />
    <DeleteConfirm target={deleteTarget} pending={Boolean(pending)} onCancel={() => { if (!busyRef.current) setDeleteTarget(null); }} onConfirm={confirmDelete} />
    <BatchImportDialog open={batchOpen} root={library.root} allowed={canManage && !pending && !editor && !deleteTarget} onClose={() => setBatchOpen(false)} onImported={(snapshot, report) => { applySnapshot(snapshot); setQuery(''); showToast({ key: 'app.batchSaved', params: report }); }} />
    <BatchProcessDialog open={processOpen} items={items} language={language} onClose={() => setProcessOpen(false)} />
    {remoteBackend && <RemoteConnectionDialog open={connectionOpen} connection={connection} allowed={connectionSupported} pending={connectionOpen ? pending : ''} onClose={() => { if (!busyRef.current) setConnectionOpen(false); }} onConnect={connectServer} onSignIn={signInServer} onSignOut={signOutServer} />}
  </RemoteConnectionContext.Provider>;
}
