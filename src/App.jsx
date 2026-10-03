import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPhoto, portraitNumber, portraits, promptFor } from './portraits.js';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import Gallery from './components/Gallery.jsx';
import DetailDialog from './components/DetailDialog.jsx';
import Toast from './components/Toast.jsx';
export default function App() {
  const [activeFilter, setActiveFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [dense, setDense] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [toast, setToast] = useState('');
  const [language, setLanguage] = useState(() => {
    try { return localStorage.getItem('portraitStudio.promptLanguage') === 'zh' ? 'zh' : 'en'; }
    catch { return 'en'; }
  });
  const searchRef = useRef(null);
  const timers = useRef({});
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return portraits.filter(item => (activeFilter === 'all' || (activeFilter === 'photo' ? isPhoto(item) : !isPhoto(item))) && (!term || `${item.id} ${item.label} ${item.image}`.toLowerCase().includes(term)));
  }, [activeFilter, query]);
  const selected = visible.find(item => item.id === selectedId) ?? null;
  const showToast = useCallback(message => {
    setToast(message);
    clearTimeout(timers.current.toast);
    timers.current.toast = setTimeout(() => setToast(''), 1900);
  }, []);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  function changeLanguage(value) {
    setLanguage(value);
    setCopiedId(null);
    try { localStorage.setItem('portraitStudio.promptLanguage', value); } catch { /* Storage may be unavailable; switching still works. */ }
  }
  useEffect(() => {
    const onKey = event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  async function copyPrompt(item, fromCard = false) {
    if (!item) return;
    try {
      const prompt = promptFor(item, language);
      const copied = await window.portraitStudio?.copyText(prompt);
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
      if (window.portraitStudio) {
        if (!await window.portraitStudio.openImage(item.image)) showToast('无法打开原图，请重试');
      } else { window.open(item.image_url, '_blank', 'noopener,noreferrer'); }
    } catch { showToast('无法打开原图，请重试'); }
  }
  function cycle(direction) {
    if (!selected || !visible.length) return;
    const index = visible.findIndex(item => item.id === selected.id);
    setSelectedId(visible[(index + direction + visible.length) % visible.length].id);
  }
  return <>
    <div className="app-shell"><Sidebar portraits={portraits} activeFilter={activeFilter} onFilter={setActiveFilter} />
      <main className="main-content"><Header query={query} onQuery={setQuery} searchRef={searchRef} dense={dense} onToggleDensity={() => setDense(value => !value)} /><Gallery items={visible} dense={dense} copiedId={copiedId} onOpen={setSelectedId} onCopy={copyPrompt} language={language} onLanguage={changeLanguage} /></main>
    </div>
    <Toast message={toast} />
    <DetailDialog item={selected} total={portraits.length} language={language} onLanguage={changeLanguage} onClose={() => setSelectedId(null)} onCopy={copyPrompt} onOpenImage={openImage} onCycle={cycle} />
  </>;
}
