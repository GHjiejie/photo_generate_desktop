import { useEffect, useRef, useState } from 'react';
import { UILanguageControl, useI18n } from '../i18n.jsx';

export default function Settings() {
  const { t, theme, setTheme } = useI18n();
  const [open, setOpen] = useState(false);
  const controlRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) { wasOpen.current = false; triggerRef.current?.focus(); }
      return;
    }
    wasOpen.current = true;
    const firstControl = panelRef.current?.querySelector('#uiLanguage button[aria-pressed="true"]') ?? panelRef.current?.querySelector('button');
    firstControl?.focus();
    const closeOutside = event => { if (!controlRef.current?.contains(event.target)) setOpen(false); };
    const closeEscape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('keydown', closeEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('keydown', closeEscape, true);
    };
  }, [open]);

  return <div ref={controlRef} className="settings-control">
    <button ref={triggerRef} id="settingsToggle" className="settings-trigger icon-button" type="button" aria-label={t('settings.open')} title={t('settings.open')} aria-haspopup="dialog" aria-expanded={open} aria-controls="settingsPanel" onClick={() => setOpen(value => !value)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m9.5 3-.6 2.4-2 .9-2.2-.7-2.5 4.3 1.6 1.7v2.3l-1.6 1.7 2.5 4.3 2.2-.7 2 .9.6 2.4h5l.6-2.4 2-.9 2.2.7 2.5-4.3-1.6-1.7v-2.3l1.6-1.7-2.5-4.3-2.2.7-2-.9L14.5 3Z" /><circle cx="12" cy="12.75" r="3" /></svg></button>
    {open && <div ref={panelRef} id="settingsPanel" className="settings-panel" role="dialog" aria-modal="false" aria-labelledby="settingsTitle">
      <div className="settings-heading"><h2 id="settingsTitle">{t('settings.title')}</h2><button type="button" className="settings-close" aria-label={t('settings.close')} title={t('settings.close')} onClick={() => setOpen(false)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
      <UILanguageControl id="uiLanguage" />
      <div id="themeControl" className="theme-control" role="group" aria-label={t('settings.theme')}><span className="language-label">{t('settings.theme')}</span><button type="button" data-theme="dark" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>{t('settings.dark')}</button><button type="button" data-theme="light" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>{t('settings.light')}</button></div>
    </div>}
  </div>;
}
