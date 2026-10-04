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
import Toast from './components/Toast.jsx';

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
  const [library, setLibrary] = useState(initialLibrary);
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
  const [batchOpen, setBatchOpen] = useState(false);
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
  const managing = Boolean(editor || deleteTarget || batchOpen);
  const canManage = desktop && library.configured && library.writable && !libraryError;
  const showToast = useCallback(message => {
    setToast(message);
    clearTimeout(timers.current.toast);
    timers.current.toast = setTimeout(() => setToast(''), 2600);
  }, []);
  const applySnapshot = useCallback(snapshot => {
    setLibrary(snapshot);
    setLibraryError('');
    if (snapshot.configured) setDetailItem(previous => previous ? snapshot.items.find(item => item.id === previous.id) ?? null : null);
  }, []);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    bridge.libraryList().then(result => {
      const snapshot = unwrap(result);
      if (live) applySnapshot(snapshot);
    }).catch(error => { if (live) setLibraryError(error); }).finally(() => {
      if (live) { busyRef.current = false; setPending(''); }
    });
    return () => { live = false; };
  }, [connected, bridge, applySnapshot]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
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
  function closeDetail() { selectionRequest.current += 1; setSelectedId(null); setDetailItem(null); }
  async function configureLibrary() {
    if (!desktop || managing) return;
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
  async function refreshLibrary() {
    if (!connected || managing) return;
    await exclusive('refresh', async () => {
      try { await readSnapshot(); showToast({ key: 'app.refreshed' }); }
      catch (error) { setLibraryError(error); showToast(error); }
    });
  }
  async function openDetail(id) {
    if (busyRef.current || managing) return;
    const request = ++selectionRequest.current;
    try {
      const item = library.configured ? unwrap(await bridge.libraryGet(id)).item : items.find(value => value.id === id);
      if (request === selectionRequest.current && item) { setSelectedId(id); setDetailItem(item); }
    } catch (error) { showToast(error); }
  }
  useEffect(() => { setCopiedId(null); }, [language]);
  useEffect(() => {
    const onKey = event => { if (!managing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [managing]);
  async function copyPrompt(item, fromCard = false) {
    if (!item) return;
    try {
      const prompt = promptFor(item, language);
      const copied = await bridge?.copyText(prompt);
      if (!copied) await navigator.clipboard.writeText(prompt);
      if (fromCard) {
        setCopiedId(item.id);
        clearTimeout(timers.current.copy);
        timers.current.copy = setTimeout(() => setCopiedId(null), 1500);
      }
      showToast({ key: 'app.promptCopied', params: { number: portraitNumber(item), languageKey: language === 'zh' ? 'app.chinese' : 'app.english' } });
    } catch { showToast({ key: 'app.copyFailed' }); }
  }
  async function openImage(item) {
    if (!item) return;
    try {
      if (bridge) {
        const target = library.configured ? { id: item.id, revision: item.revision } : item.image;
        if (!await bridge.openImage(target)) showToast({ key: 'app.imageFailed' });
      } else { window.open(item.image_url, '_blank', 'noopener,noreferrer'); }
    } catch { showToast({ key: 'app.imageFailed' }); }
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
    catch (error) { showToast({ key: 'app.releaseFailed', params: { error } }); }
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
      } catch (error) { setEditor(previous => previous?.session === session ? { ...previous, error: error } : previous); }
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
        let conflict = null;
        if (error.code === 'CONFLICT') {
          try { const snapshot = await readSnapshot(); conflict = { ...snapshot, item: snapshot.items.find(item => item.id === editor.item?.id) }; }
          catch (refreshError) { setLibraryError(refreshError); }
        }
        setEditor(previous => previous?.session === session ? { ...previous, error: error.code === 'CONFLICT' ? { key: 'app.editConflict' } : error, conflict, reviewOpen: false } : previous);
      }
    });
  }
  function acknowledgeConflict() {
    setEditor(previous => previous?.conflict ? { ...previous, version: previous.conflict.revision, item: previous.conflict.item ?? previous.item, itemRevision: previous.conflict.item?.revision, conflict: null, reviewOpen: false, error: '' } : previous);
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
    if (!deleteTarget || deleteTarget.conflicted || !canManage) return;
    await exclusive('delete', async () => {
      try {
        const snapshot = unwrap(await bridge.deletePortrait({ id: deleteTarget.item.id, expectedVersion: deleteTarget.version, expectedRevision: deleteTarget.item.revision, confirmed: true }));
        closeDetail();
        applySnapshot(snapshot);
        setDeleteTarget(null);
        showToast({ key: 'app.deleted' });
      } catch (error) {
        if (error.code === 'CONFLICT') { try { await readSnapshot(); } catch (refreshError) { setLibraryError(refreshError); } }
        setDeleteTarget(previous => previous ? { ...previous, error: error.code === 'CONFLICT' ? { key: 'app.deleteConflict' } : error, conflicted: error.code === 'CONFLICT' } : previous);
      }
    });
  }
  let notice = '';
  if (libraryError) notice = t('app.libraryError', { error: errorText(libraryError) });
  else if (pending === 'loading') notice = t('app.loading');
  else if (!browserPreview) {
    if (!desktop) notice = t('app.desktopRequired');
    else if (!library.configured) notice = t('app.noLibrary');
    else if (!library.writable) notice = t('app.readonly');
  }
  const toastText = toast?.key ? t(toast.key, { ...toast.params, ...(toast.params?.error ? { error: errorText(toast.params.error) } : {}), ...(toast.params?.languageKey ? { language: t(toast.params.languageKey) } : {}) }) : errorText(toast);
  return <>
    <div className="app-shell"><Sidebar portraits={items} />
      <main className="main-content"><Header query={query} onQuery={setQuery} searchRef={searchRef} dense={dense} onToggleDensity={() => setDense(value => !value)} library={library} desktop={desktop} connected={connected} editable={canManage} pending={Boolean(pending) || managing} onConfigure={configureLibrary} onRefresh={refreshLibrary} onCreate={beginCreate} onBatch={() => { if (canManage && !busyRef.current && !managing) setBatchOpen(true); }} />{notice && <div id="libraryNotice" className={`library-notice${libraryError ? ' error' : ''}`} role={libraryError ? 'alert' : 'status'}>{notice}</div>}<Gallery items={visible} dense={dense} copiedId={copiedId} onOpen={openDetail} onCopy={copyPrompt} configured={library.configured} query={query} /></main>
    </div>
    <Toast message={toastText} />
    <DetailDialog item={selected} total={items.length} language={language} onClose={closeDetail} onCopy={copyPrompt} onOpenImage={openImage} onCycle={cycle} canManage={canManage} pending={Boolean(pending) || managing} onEdit={beginEdit} onDelete={beginDelete} />
    <PortraitEditor editor={editor} pending={Boolean(pending)} saving={pending === 'save'} canSave={canManage} onCancel={cancelEditor} onChooseImage={chooseEditorImage} onSave={saveEditor} onReviewConflict={() => setEditor(previous => ({ ...previous, reviewOpen: true }))} onAcknowledgeConflict={acknowledgeConflict} />
    <DeleteConfirm target={deleteTarget} pending={Boolean(pending)} onCancel={() => { if (!busyRef.current) setDeleteTarget(null); }} onConfirm={confirmDelete} />
    <BatchImportDialog open={batchOpen} root={library.root} allowed={canManage && !pending && !editor && !deleteTarget} onClose={() => setBatchOpen(false)} onImported={(snapshot, report) => { applySnapshot(snapshot); setQuery(''); showToast({ key: 'app.batchSaved', params: report }); }} />
  </>;
}
