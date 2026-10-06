import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { labelFor, portraitNumber, promptFor } from '../portraits.js';
import { ShuffleIcon, StarIcon } from './FavoriteButton.jsx';
import { CreativeLabIcon } from './CreativeLab.jsx';
import './slideshow.css';

export function SlideshowIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="m10 8 5 2.5-5 2.5V8ZM12 17v4m-4 0h8" /></svg>;
}

function PlayIcon({ playing }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{playing ? <><path d="M8 5v14M16 5v14" /></> : <path d="m8 4 12 8-12 8V4Z" />}</svg>;
}

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function loopOrder(ids, previousId, backwards) {
  const order = shuffled(ids);
  const edge = backwards ? order.length - 1 : 0;
  if (order.length > 1 && order[edge] === previousId) {
    const other = backwards ? 0 : order.length - 1;
    [order[edge], order[other]] = [order[other], order[edge]];
  }
  return order;
}

function isEditable(target) {
  return target instanceof Element && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')));
}

export default function Slideshow({ items, language, favoriteIds, pending, onToggleFavorite, onOpenDetail, onCreativeLab, onCopy, onRetryImage }) {
  const { t, uiLanguage } = useI18n();
  const uniqueItems = useMemo(() => [...new Map(items.map(item => [item.id, item])).values()], [items]);
  const originalIds = useMemo(() => uniqueItems.map(item => item.id), [uniqueItems]);
  const itemMap = useMemo(() => new Map(uniqueItems.map(item => [item.id, item])), [uniqueItems]);
  const [sequence, setSequence] = useState(() => ({ ids: originalIds, index: 0, shuffle: false }));
  const [playing, setPlaying] = useState(false);
  const [interval, setInterval] = useState(5);
  const [promptOpen, setPromptOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [imageState, setImageState] = useState({ key: '', status: 'loading' });
  const [timerVersion, setTimerVersion] = useState(0);
  const [hidden, setHidden] = useState(() => document.hidden);
  const activeImageKeyRef = useRef('');
  const currentItem = itemMap.get(sequence.ids[sequence.index]);
  const imageKey = currentItem ? `${currentItem.id}:${currentItem.image_url}:${attempt}` : '';
  activeImageKeyRef.current = imageKey;
  const status = imageState.key === imageKey ? imageState.status : 'loading';
  const favorite = Boolean(currentItem && favoriteIds?.has(currentItem.id));
  const label = currentItem ? labelFor(currentItem, uiLanguage) || t('show.imageNumber', { number: portraitNumber(currentItem) }) : '';
  const prompt = promptFor(currentItem, language);
  const canNavigate = sequence.ids.length > 1 && !pending;
  const activelyPlaying = playing && canNavigate && !hidden && status === 'loaded';

  useEffect(() => {
    setSequence(previous => {
      const currentId = previous.ids[previous.index];
      const availableIds = new Set(originalIds);
      const sameOrder = previous.ids.length === originalIds.length && previous.ids.every((id, index) => previous.shuffle ? availableIds.has(id) : originalIds[index] === id);
      if (sameOrder) return previous;
      if (previous.shuffle) {
        const hasCurrent = availableIds.has(currentId);
        return { ids: hasCurrent ? [currentId, ...shuffled(originalIds.filter(id => id !== currentId))] : shuffled(originalIds), index: 0, shuffle: true };
      }
      return { ids: originalIds, index: Math.max(0, originalIds.indexOf(currentId)), shuffle: false };
    });
    if (originalIds.length < 2) setPlaying(false);
  }, [originalIds]);

  useEffect(() => {
    const visibilityChanged = () => {
      setHidden(document.hidden);
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, []);

  const navigate = useCallback(direction => {
    if (pending || sequence.ids.length < 2) return;
    setTimerVersion(value => value + 1);
    setAttempt(0);
    setSequence(previous => {
      const next = previous.index + direction;
      if (next >= 0 && next < previous.ids.length) return { ...previous, index: next };
      if (previous.shuffle) {
        return { ...previous, ids: loopOrder(previous.ids, previous.ids[previous.index], direction < 0), index: direction < 0 ? previous.ids.length - 1 : 0 };
      }
      return { ...previous, index: (next + previous.ids.length) % previous.ids.length };
    });
  }, [pending, sequence.ids.length]);

  useEffect(() => {
    if (!activelyPlaying) return;
    const timer = window.setTimeout(() => {
      if (!document.hidden) navigate(1);
    }, interval * 1000);
    return () => window.clearTimeout(timer);
  }, [activelyPlaying, imageKey, sequence.index, interval, timerVersion, navigate]);

  function togglePlayback() {
    if (canNavigate && !document.hidden) setPlaying(value => !value);
  }

  function toggleShuffle() {
    if (!canNavigate) return;
    setTimerVersion(value => value + 1);
    setSequence(previous => {
      const currentId = previous.ids[previous.index];
      if (previous.shuffle) return { ids: originalIds, index: Math.max(0, originalIds.indexOf(currentId)), shuffle: false };
      return { ids: [currentId, ...shuffled(originalIds.filter(id => id !== currentId))], index: 0, shuffle: true };
    });
  }

  async function retryImage() {
    if (pending || !currentItem) return;
    try {
      const success = onRetryImage ? await onRetryImage(currentItem) : true;
      if (success) {
        setAttempt(value => value + 1);
        setTimerVersion(value => value + 1);
      }
    } catch { /* The parent reports refresh failures; retain the failed image for another retry. */ }
  }

  function openAction(action) {
    if (!currentItem || pending) return;
    setPlaying(false);
    action(currentItem);
  }

  return <section id="slideshow" className="slideshow" data-playing={activelyPlaying} data-play-requested={playing} data-current-id={currentItem?.id ?? ''} data-image-state={currentItem ? status : 'empty'} aria-label={t('show.title')} onKeyDown={event => {
    event.stopPropagation();
    if (pending || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditable(event.target)) return;
    if (event.key === 'ArrowLeft' && canNavigate) { event.preventDefault(); navigate(-1); }
    if (event.key === 'ArrowRight' && canNavigate) { event.preventDefault(); navigate(1); }
  }}>
    <div className="slideshow-stage">
      <div id="slideshowViewport" className="slideshow-viewport" role="region" aria-label={label || t('show.title')} aria-describedby="slideshowHint" aria-busy={Boolean(currentItem && status === 'loading')} tabIndex={0} onClick={event => {
        if (!event.target.closest('button')) event.currentTarget.focus();
      }} onKeyDown={event => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ![' ', 'Spacebar'].includes(event.key)) return;
        event.stopPropagation();
        event.preventDefault();
        if (!event.repeat) togglePlayback();
      }}>
        {currentItem && <img key={imageKey} id="slideshowImage" className="slideshow-image" src={currentItem.image_url} alt={label} hidden={status !== 'loaded'} draggable={false} onLoad={event => {
          if (activeImageKeyRef.current !== imageKey) return;
          const loaded = event.currentTarget.naturalWidth && event.currentTarget.naturalHeight;
          setImageState({ key: imageKey, status: loaded ? 'loaded' : 'error' });
          if (!loaded) setPlaying(false);
        }} onError={() => {
          if (activeImageKeyRef.current === imageKey) { setImageState({ key: imageKey, status: 'error' }); setPlaying(false); }
        }} />}
        {!currentItem && <div className="slideshow-status"><SlideshowIcon /><p>{t('show.empty')}</p></div>}
        {currentItem && status === 'loading' && <div className="slideshow-status" role="status"><span className="slideshow-loading-mark" aria-hidden="true">•••</span><p>{t('show.loading')}</p></div>}
        {currentItem && status === 'error' && <div className="slideshow-status" role="alert"><p>{t('show.error')}</p><button id="slideshowRetry" className="slideshow-button" type="button" disabled={pending} onClick={retryImage}>{t('show.retry')}</button></div>}
      </div>
      {currentItem && <div className="slideshow-caption"><span className="slideshow-item-number">{t('show.imageNumber', { number: portraitNumber(currentItem) })}</span><h3 title={label}>{label}</h3></div>}
      <button id="slideshowPrevious" className="slideshow-stage-arrow previous" type="button" disabled={!canNavigate} aria-label={t('show.previous')} title={t('show.previous')} onClick={() => navigate(-1)}><span aria-hidden="true">‹</span></button>
      <button id="slideshowNext" className="slideshow-stage-arrow next" type="button" disabled={!canNavigate} aria-label={t('show.next')} title={t('show.next')} onClick={() => navigate(1)}><span aria-hidden="true">›</span></button>
    </div>
    <div className="slideshow-controls">
      <div className="slideshow-playback-controls">
        <button id="slideshowPlay" className="slideshow-button slideshow-play" type="button" disabled={!canNavigate} aria-pressed={playing} onClick={togglePlayback}><PlayIcon playing={playing} /><span>{t(playing ? 'show.pause' : 'show.play')}</span></button>
        <output id="slideshowPosition" className="slideshow-position" aria-live={playing ? 'off' : 'polite'}>{t('show.position', { position: currentItem ? sequence.index + 1 : 0, total: sequence.ids.length })}</output>
        <label className="slideshow-interval" htmlFor="slideshowInterval"><span>{t('show.interval')}</span><select id="slideshowInterval" value={interval} disabled={pending || sequence.ids.length < 2} onChange={event => { setInterval(Number(event.target.value)); setTimerVersion(value => value + 1); }}>{[3, 5, 8, 12].map(seconds => <option key={seconds} value={seconds}>{t('show.seconds', { seconds })}</option>)}</select></label>
        <button id="slideshowShuffle" className="slideshow-button slideshow-shuffle" type="button" disabled={!canNavigate} aria-pressed={sequence.shuffle} onClick={toggleShuffle}><ShuffleIcon /><span>{t('show.shuffle')}</span></button>
      </div>
      <div className="slideshow-item-controls">
        <button id="slideshowFavorite" className={`slideshow-button${favorite ? ' is-favorite' : ''}`} type="button" disabled={!currentItem || pending || !onToggleFavorite} aria-pressed={favorite} onClick={() => onToggleFavorite(currentItem.id)}><StarIcon filled={favorite} /><span>{t(favorite ? 'show.unfavorite' : 'show.favorite')}</span></button>
        <button id="slideshowDetails" className="slideshow-button" type="button" disabled={!currentItem || pending} onClick={() => openAction(onOpenDetail)}>{t('show.details')}</button>
        <button id="slideshowCreativeLab" className="slideshow-button" type="button" disabled={!currentItem || pending} onClick={() => openAction(onCreativeLab)}><CreativeLabIcon /><span>{t('show.creativeLab')}</span></button>
        <button id="slideshowPromptToggle" className="slideshow-button" type="button" disabled={!currentItem} aria-expanded={promptOpen} aria-controls="slideshowPromptPanel" onClick={() => setPromptOpen(value => !value)}>{t(promptOpen ? 'show.hidePrompt' : 'show.showPrompt')}</button>
      </div>
    </div>
    {promptOpen && currentItem && <section id="slideshowPromptPanel" className="slideshow-prompt-panel" aria-labelledby="slideshowPromptTitle"><header><h4 id="slideshowPromptTitle">{t('show.prompt')}</h4><button id="slideshowCopy" className="slideshow-button" type="button" disabled={pending || !prompt.trim()} onClick={() => onCopy(currentItem)}><span aria-hidden="true">⧉</span>{t('show.copy')}</button></header><pre id="slideshowPrompt" lang={language === 'zh' ? 'zh-CN' : 'en'}>{prompt || t('show.noPrompt')}</pre></section>}
    <p id="slideshowHint" className="slideshow-hint">{t(sequence.ids.length === 1 ? 'show.single' : 'show.hint')}</p>
  </section>;
}
