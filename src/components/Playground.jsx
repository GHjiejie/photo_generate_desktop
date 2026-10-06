import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import InspirationDuel, { DuelIcon } from './InspirationDuel.jsx';
import Slideshow, { SlideshowIcon } from './Slideshow.jsx';
import './playground.css';

export function PlaygroundIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM20 15l.8 2.2L23 18l-2.2.8L20 21l-.8-2.2L17 18l2.2-.8M4 2v4M2 4h4" /></svg>;
}

export default function Playground({ session, language, favoriteIds, pending, feedback, onClose, onToggleFavorite, onOpenDetail, onCreativeLab, onCopy, onRetryImage }) {
  const { t } = useI18n();
  const dialogRef = useRef(null);
  const restoreFocus = useRef(false);
  const backRef = useRef(null);
  const [mode, setMode] = useState('home');
  const items = session?.items ?? [];
  useEffect(() => { setMode('home'); }, [session?.id]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (session && !dialog.open) dialog.showModal();
    else if (!session && dialog.open) {
      dialog.close();
      if (restoreFocus.current) {
        const trigger = document.getElementById('openPlayground');
        const target = trigger && !trigger.disabled ? trigger : document.getElementById('searchInput');
        target?.focus();
      }
      restoreFocus.current = false;
    }
  }, [session]);
  useEffect(() => {
    if (!session) return;
    if (mode !== 'home') backRef.current?.focus();
    else dialogRef.current?.querySelector('#playDuel:not(:disabled), #playSlideshow:not(:disabled)')?.focus();
  }, [mode, session?.id]);
  const shared = { items, favoriteIds, pending, onToggleFavorite, onOpenDetail, onCreativeLab };
  const close = () => { if (!pending) { restoreFocus.current = true; onClose(); } };
  return <dialog ref={dialogRef} id="playgroundDialog" className={`playground-dialog mode-${mode}`} aria-labelledby="playgroundTitle" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="playground-heading">
      <div className="playground-heading-title"><span className="playground-mark"><PlaygroundIcon /></span><div><h2 id="playgroundTitle">{t(mode === 'duel' ? 'duel.title' : mode === 'slideshow' ? 'show.title' : 'play.title')}</h2><p>{t('play.scope', { count: items.length })}</p></div></div>
      <div className="playground-heading-actions">{mode !== 'home' && <button ref={backRef} id="playgroundBack" className="secondary-button" type="button" disabled={pending} onClick={() => setMode('home')}>{t('play.back')}</button>}<button id="closePlayground" className="playground-close" type="button" disabled={pending} aria-label={t('common.close')} title={t('common.close')} onClick={close}>×</button></div>
    </header>
    {session && feedback && <p id="playgroundFeedback" className={`playground-feedback${feedback.error ? ' error' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {session && <div className="playground-content">
      {mode === 'home' && <div className="playground-home"><div className="playground-welcome"><span>{t('play.kicker')}</span><h3>{t('play.welcome')}</h3><p>{t('play.intro')}</p></div><div className="playground-options">
        <button id="playDuel" className="playground-option" type="button" disabled={pending || items.length < 2} onClick={() => setMode('duel')}><span className="playground-option-icon"><DuelIcon /></span><strong>{t('duel.title')}</strong><span className="playground-option-description">{t(items.length < 2 ? 'duel.empty' : 'play.duelIntro')}</span><span className="playground-option-cta">{t('play.tryDuel')}<span aria-hidden="true">↗</span></span></button>
        <button id="playSlideshow" className="playground-option" type="button" disabled={pending || !items.length} onClick={() => setMode('slideshow')}><span className="playground-option-icon"><SlideshowIcon /></span><strong>{t('show.title')}</strong><span className="playground-option-description">{t('play.showIntro')}</span><span className="playground-option-cta">{t('play.tryShow')}<span aria-hidden="true">↗</span></span></button>
      </div></div>}
      {mode === 'duel' && <InspirationDuel {...shared} />}
      {mode === 'slideshow' && <Slideshow {...shared} language={language} onCopy={onCopy} onRetryImage={onRetryImage} />}
    </div>}
  </dialog>;
}
