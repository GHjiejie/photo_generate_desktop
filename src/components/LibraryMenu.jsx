import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useI18n } from '../i18n.jsx';

function Icon({ name }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{name === 'image' ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m21 15-5-5L5 21" /></> : name === 'batch' ? <><rect x="7" y="7" width="14" height="14" rx="2" /><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2m4-2 3-3 7 7" /></> : name === 'refresh' ? <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1" /></> : <path d="M3 7V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />}</svg>;
}

export default function LibraryMenu({ library, desktop, connected, editable, pending, onConfigure, onRefresh, onCreate, onBatch }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const controlRef = useRef(null), triggerRef = useRef(null), panelRef = useRef(null), wasOpen = useRef(false);
  useEffect(() => {
    if (!open) { if (wasOpen.current) { wasOpen.current = false; triggerRef.current?.focus(); } return; }
    wasOpen.current = true;
    (panelRef.current?.querySelector('.library-menu-action:not(:disabled)') ?? panelRef.current?.querySelector('button'))?.focus();
    const outside = event => { if (!controlRef.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  function perform(enabled, action) {
    if (!enabled || typeof action !== 'function') return;
    flushSync(() => setOpen(false));
    action();
  }
  const canEdit = Boolean(editable && !pending), canConfigure = Boolean(desktop && !pending), canRefresh = Boolean(connected && !pending);
  const desktopTitle = !desktop ? t('common.desktopOnly') : undefined;
  return <div ref={controlRef} className="library-menu-control">
    <button ref={triggerRef} id="libraryMenuToggle" className="library-menu-trigger icon-button" type="button" aria-label={t('library.manage')} title={t('library.manage')} aria-haspopup="dialog" aria-expanded={open} aria-controls="libraryMenuPanel" onClick={() => setOpen(value => !value)}><Icon name="folder" /></button>
    {open && <div ref={panelRef} id="libraryMenuPanel" className="library-menu-panel" role="dialog" aria-modal="false" aria-labelledby="libraryMenuTitle">
      <div className="library-menu-heading"><h2 id="libraryMenuTitle">{t('library.manage')}</h2><button className="library-menu-close" type="button" aria-label={t('common.close')} title={t('common.close')} onClick={() => setOpen(false)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
      <div id="libraryStatus" className="library-menu-status"><span className={`status-dot${!library?.configured || !library?.writable ? ' readonly' : ''}`} />{t(library?.configured ? library.writable ? 'sidebar.editable' : 'sidebar.readonly' : 'sidebar.disconnected')}</div>
      {library?.configured && <div id="libraryRoot" className="library-root" title={library.root}>{library.root}</div>}
      <div className="library-menu-actions"><button id="libraryCreate" className="library-menu-action" type="button" disabled={!canEdit} title={desktopTitle} onClick={() => perform(canEdit, onCreate)}><Icon name="image" /><span>{t('library.import')}</span></button>
      <button id="libraryConfigure" className="library-menu-action" type="button" disabled={!canConfigure} title={desktopTitle} onClick={() => perform(canConfigure, onConfigure)}><Icon name="folder" /><span>{t(library?.configured ? 'sidebar.switch' : 'sidebar.choose')}</span></button>
      <button id="libraryBatch" className="library-menu-action" type="button" disabled={!canEdit} title={desktopTitle} onClick={() => perform(canEdit, onBatch)}><Icon name="batch" /><span>{t('sidebar.batch')}</span></button>
      <button id="libraryRefresh" className="library-menu-action" type="button" disabled={!canRefresh} onClick={() => perform(canRefresh, onRefresh)}><Icon name="refresh" /><span>{t('sidebar.refresh')}</span></button></div>
    </div>}
  </div>;
}
