import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { portraitNumber, promptFor } from './portraits.js';
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
  const [dense, setDense] = useState(false);
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
  const searchRef = useRef(null);
  const timers = useRef({});
  const busyRef = useRef(connected);
  const selectionRequest = useRef(0);
  const editorSession = useRef(0);
  const items = library.configured ? library.items : [];
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return items.filter(item => !term || [item.id, item.label, item.image, item.prompts?.en, item.prompts?.zh, item.sourceMetadata?.label_en, item.sourceMetadata?.label_cn, item.sourceMetadata?.style_tag_en, item.sourceMetadata?.style_tag_cn].filter(value => value != null).join(' ').toLowerCase().includes(term));
  }, [items, query]);
  const selected = detailItem?.id === selectedId ? detailItem : null;
  const managing = Boolean(editor || deleteTarget || batchOpen || processOpen || connectionOpen);
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
    timers.current.toast = setTimeout(() => setToast(''), message?.key === 'app.batchDeletePartial' ? 6500 : 2600);
  }, [remoteBackend]);
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
      if (!managing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [managing, pending, selectionMode]);
  async function copyPrompt(item, fromCard = false) {
    if (!item) return;
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
    } catch { if (!await updateAuthenticationAfterBooleanFailure()) showToast({ key: 'app.copyFailed' }); }
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
    openDetail(visible[(index + direction + visible.length) % visible.length].id);
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
  return <RemoteConnectionContext.Provider value={{ backend: remoteBackend ? 'remote' : 'local', root: library.root, configured: library.configured, allowed: (remoteBackend ? connectionSupported : desktop && typeof bridge?.chooseLibrary === 'function') && !pending && !managing, onOpen: remoteBackend ? openConnectionSettings : configureLibrary, onAuthenticationError: error => { if (remoteBackend && isAuthenticationError(error)) showToast(error); } }}>
    <div className="app-shell"><Sidebar portraits={items} />
      <main className="main-content"><Header query={query} onQuery={setQuery} searchRef={searchRef} dense={dense} onToggleDensity={() => setDense(value => !value)} library={visibleLibrary} desktop={desktop} connected={connected} editable={canManage} pending={Boolean(pending) || managing} onConfigure={configureLibrary} onRefresh={refreshLibrary} onCreate={beginCreate} onBatch={() => { if (canManage && !busyRef.current && !managing) setBatchOpen(true); }} onProcess={() => { if (connected && library.configured && !busyRef.current && !managing) setProcessOpen(true); }} canBatchDelete={canBatchDelete && items.length > 0} onSelect={beginSelection} />{notice && <div id="libraryNotice" className={`library-notice${libraryError ? ' error' : ''}`} role={libraryError ? 'alert' : 'status'}>{notice}</div>}<Gallery items={visible} dense={dense} copiedId={copiedId} onOpen={openDetail} onCopy={copyPrompt} configured={library.configured} query={query} selectedIds={selectedIds} onToggleSelect={toggleSelect} onBatchDelete={beginBatchDelete} batchMode={selectionMode} canBatchDelete={canBatchDelete} pending={Boolean(pending) || managing} onBeginSelection={beginSelection} onEndSelection={endSelection} onToggleVisible={toggleVisibleSelection} onClearSelection={() => { if (!busyRef.current && !managing) setSelectedIds(new Set()); }} /></main>
    </div>
    <Toast message={toastText} error={toast?.key === 'app.batchDeletePartial'} />
    <DetailDialog item={selected} total={items.length} language={language} onClose={closeDetail} onCopy={copyPrompt} onOpenImage={openImage} onCycle={cycle} canManage={canManage} pending={Boolean(pending) || managing} onEdit={beginEdit} onDelete={beginDelete} />
    <PortraitEditor editor={editor} pending={Boolean(pending)} saving={pending === 'save'} canSave={canManage} onCancel={cancelEditor} onChooseImage={chooseEditorImage} onSave={saveEditor} onReviewConflict={() => setEditor(previous => ({ ...previous, reviewOpen: true }))} onAcknowledgeConflict={acknowledgeConflict} />
    <DeleteConfirm target={deleteTarget} pending={Boolean(pending)} onCancel={() => { if (!busyRef.current) setDeleteTarget(null); }} onConfirm={confirmDelete} />
    <BatchImportDialog open={batchOpen} root={library.root} allowed={canManage && !pending && !editor && !deleteTarget} onClose={() => setBatchOpen(false)} onImported={(snapshot, report) => { applySnapshot(snapshot); setQuery(''); showToast({ key: 'app.batchSaved', params: report }); }} />
    <BatchProcessDialog open={processOpen} items={items} language={language} onClose={() => setProcessOpen(false)} />
    {remoteBackend && <RemoteConnectionDialog open={connectionOpen} connection={connection} allowed={connectionSupported} pending={connectionOpen ? pending : ''} onClose={() => { if (!busyRef.current) setConnectionOpen(false); }} onConnect={connectServer} onSignIn={signInServer} onSignOut={signOutServer} />}
  </RemoteConnectionContext.Provider>;
}
