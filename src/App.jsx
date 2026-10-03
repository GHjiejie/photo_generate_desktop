import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPhoto, portraitNumber, portraits, promptFor } from './portraits.js';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import Gallery from './components/Gallery.jsx';
import DetailDialog from './components/DetailDialog.jsx';
import PortraitEditor from './components/PortraitEditor.jsx';
import DeleteConfirm from './components/DeleteConfirm.jsx';
import UpdateDialog from './components/UpdateDialog.jsx';
import Toast from './components/Toast.jsx';

const initialLibrary = { configured: false, root: '', writable: false, revision: null, items: [] };
function unwrap(result) {
  if (result?.ok) return result.data;
  const error = new Error(result?.error?.message || '本地素材操作失败，请重试。');
  error.code = result?.error?.code || 'UNAVAILABLE';
  throw error;
}
export default function App() {
  const bridge = window.portraitStudio;
  const desktop = typeof bridge?.libraryList === 'function';
  const [library, setLibrary] = useState(initialLibrary);
  const [libraryError, setLibraryError] = useState('');
  const [pending, setPending] = useState(desktop ? 'loading' : '');
  const [activeFilter, setActiveFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [dense, setDense] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detailItem, setDetailItem] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [toast, setToast] = useState('');
  const [editor, setEditor] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [language, setLanguage] = useState(() => {
    try { return localStorage.getItem('portraitStudio.promptLanguage') === 'zh' ? 'zh' : 'en'; }
    catch { return 'en'; }
  });
  const searchRef = useRef(null);
  const timers = useRef({});
  const busyRef = useRef(desktop);
  const selectionRequest = useRef(0);
  const editorSession = useRef(0);
  const items = library.configured ? library.items : portraits;
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return items.filter(item => (activeFilter === 'all' || (activeFilter === 'photo' ? isPhoto(item) : !isPhoto(item))) && (!term || `${item.id} ${item.label} ${item.image}`.toLowerCase().includes(term)));
  }, [items, activeFilter, query]);
  const selected = detailItem?.id === selectedId ? detailItem : null;
  const managing = Boolean(editor || deleteTarget || updatesOpen);
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
    if (!desktop) return;
    let live = true;
    bridge.libraryList().then(result => {
      const snapshot = unwrap(result);
      if (live) applySnapshot(snapshot);
    }).catch(error => { if (live) setLibraryError(error.message); }).finally(() => {
      if (live) { busyRef.current = false; setPending(''); }
    });
    return () => { live = false; };
  }, [desktop, bridge, applySnapshot]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  useEffect(() => {
    if (!desktop || pending || typeof bridge.acknowledgeAppReady !== 'function') return;
    let second;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => bridge.acknowledgeAppReady().catch(() => {}));
    });
    return () => { cancelAnimationFrame(first); if (second) cancelAnimationFrame(second); };
  }, [desktop, pending, bridge]);
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
        setActiveFilter('all');
        setQuery('');
        showToast(data.writable ? '已连接本地素材目录' : '素材目录已连接，但没有写入权限');
      } catch (error) { setLibraryError(error.message); showToast(error.message); }
    });
  }
  async function refreshLibrary() {
    if (!desktop || managing) return;
    await exclusive('refresh', async () => {
      try { await readSnapshot(); showToast('本地素材已刷新'); }
      catch (error) { setLibraryError(error.message); showToast(error.message); }
    });
  }
  async function openDetail(id) {
    if (busyRef.current || managing) return;
    const request = ++selectionRequest.current;
    try {
      const item = library.configured ? unwrap(await bridge.libraryGet(id)).item : items.find(value => value.id === id);
      if (request === selectionRequest.current && item) { setSelectedId(id); setDetailItem(item); }
    } catch (error) { showToast(error.message); }
  }
  function changeLanguage(value) {
    setLanguage(value);
    setCopiedId(null);
    try { localStorage.setItem('portraitStudio.promptLanguage', value); } catch { /* Switching still works when storage is unavailable. */ }
  }
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
      showToast(`${portraitNumber(item)} · ${language === 'zh' ? '中文' : '英文'}完整提示词已复制`);
    } catch { showToast('复制失败，请重试'); }
  }
  async function openImage(item) {
    if (!item) return;
    try {
      if (bridge) {
        const target = library.configured ? { id: item.id, revision: item.revision } : item.image;
        if (!await bridge.openImage(target)) showToast('无法打开原图，请刷新素材后重试');
      } else { window.open(item.image_url, '_blank', 'noopener,noreferrer'); }
    } catch { showToast('无法打开原图，请重试'); }
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
      } catch (error) { showToast(error.message); }
    });
  }
  async function releaseSelection(token) {
    if (!token) return;
    try { unwrap(await bridge.releaseImage(token)); }
    catch (error) { showToast(`待选图片清理失败：${error.message}`); }
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
      } catch (error) { setEditor(previous => previous?.session === session ? { ...previous, error: error.message } : previous); }
    });
  }
  async function saveEditor(draft) {
    if (!editor || editor.conflict || !canManage) return;
    if (!draft.label.trim() || !draft.prompts.en.trim() || !draft.prompts.zh.trim()) { setEditor(previous => ({ ...previous, error: '名称和中英完整提示词均不能为空。' })); return; }
    if (editor.mode === 'create' && !editor.image) { setEditor(previous => ({ ...previous, error: '请先导入一张肖像图片。' })); return; }
    const session = editor.session;
    await exclusive('save', async () => {
      try {
        const payload = { ...draft, expectedVersion: editor.version, ...(editor.image ? { imageToken: editor.image.token } : {}), ...(editor.mode === 'edit' ? { expectedRevision: editor.itemRevision } : {}) };
        const snapshot = unwrap(await (editor.mode === 'edit' ? bridge.updatePortrait(payload) : bridge.createPortrait(payload)));
        applySnapshot(snapshot);
        setEditor(null);
        await releaseSelection(editor.image?.token);
        if (editor.mode === 'create') { setActiveFilter('all'); setQuery(''); }
        showToast(editor.mode === 'edit' ? '肖像修改已保存到本地素材库' : '肖像已加入本地素材库');
      } catch (error) {
        let conflict = null;
        if (error.code === 'CONFLICT') {
          try { const snapshot = await readSnapshot(); conflict = { ...snapshot, item: snapshot.items.find(item => item.id === editor.item?.id) }; }
          catch (refreshError) { setLibraryError(refreshError.message); }
        }
        setEditor(previous => previous?.session === session ? { ...previous, error: error.code === 'CONFLICT' ? `${error.message} 本次未保存，输入已保留，请核对最新记录。` : error.message, conflict, reviewOpen: false } : previous);
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
      } catch (error) { showToast(error.message); }
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
        showToast('图片已移到系统废纸篓，提示词和恢复记录已保留');
      } catch (error) {
        if (error.code === 'CONFLICT') { try { await readSnapshot(); } catch (refreshError) { setLibraryError(refreshError.message); } }
        setDeleteTarget(previous => previous ? { ...previous, error: error.code === 'CONFLICT' ? '图库已更新，本次未删除。请取消后重新打开详情，核对这张肖像。' : error.message, conflicted: error.code === 'CONFLICT' } : previous);
      }
    });
  }
  let notice = '';
  if (libraryError) notice = `本地素材操作提示：${libraryError}`;
  else if (pending === 'loading') notice = '正在读取本地素材目录…';
  else if (!desktop) notice = '当前为网页预览，内置精选可浏览和复制。新增、编辑与删除请使用 Mac 桌面应用。';
  else if (!library.configured) notice = '当前显示内置精选，素材只读。选择真实本地素材目录后，即可新增、编辑和移到废纸篓。';
  else if (!library.writable) notice = '这个素材目录没有写入权限。可以浏览和复制，请选择可写目录后管理素材。';
  return <>
    <div className="app-shell"><Sidebar portraits={items} activeFilter={activeFilter} onFilter={setActiveFilter} library={library} desktop={desktop} editable={canManage} pending={Boolean(pending) || managing} onConfigure={configureLibrary} onRefresh={refreshLibrary} onCreate={beginCreate} onUpdates={() => { if (!busyRef.current && !managing) setUpdatesOpen(true); }} />
      <main className="main-content"><Header query={query} onQuery={setQuery} searchRef={searchRef} dense={dense} onToggleDensity={() => setDense(value => !value)} />{notice && <div id="libraryNotice" className={`library-notice${libraryError ? ' error' : ''}`} role={libraryError ? 'alert' : 'status'}>{notice}</div>}<Gallery items={visible} dense={dense} copiedId={copiedId} onOpen={openDetail} onCopy={copyPrompt} language={language} onLanguage={changeLanguage} configured={library.configured} query={query} /></main>
    </div>
    <Toast message={toast} />
    <DetailDialog item={selected} total={items.length} language={language} onLanguage={changeLanguage} onClose={closeDetail} onCopy={copyPrompt} onOpenImage={openImage} onCycle={cycle} canManage={canManage} pending={Boolean(pending) || managing} onEdit={beginEdit} onDelete={beginDelete} />
    <PortraitEditor editor={editor} pending={Boolean(pending)} saving={pending === 'save'} canSave={canManage} onCancel={cancelEditor} onChooseImage={chooseEditorImage} onSave={saveEditor} onReviewConflict={() => setEditor(previous => ({ ...previous, reviewOpen: true }))} onAcknowledgeConflict={acknowledgeConflict} />
    <DeleteConfirm target={deleteTarget} pending={Boolean(pending)} onCancel={() => { if (!busyRef.current) setDeleteTarget(null); }} onConfirm={confirmDelete} />
    <UpdateDialog open={updatesOpen} onClose={() => setUpdatesOpen(false)} installationAllowed={!pending && !editor && !deleteTarget} />
  </>;
}
