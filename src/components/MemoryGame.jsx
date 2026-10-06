import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { labelFor, portraitNumber } from '../portraits.js';
import { availablePairCounts, createMemoryGame, flipMemoryCard, resolveMemoryMismatch, uniqueMemoryItems } from '../memory-game.mjs';
import { StarIcon } from './FavoriteButton.jsx';
import { CreativeLabIcon } from './CreativeLab.jsx';
import './memory-game.css';

export function MemoryIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="7" height="8" rx="1.5" /><rect x="14" y="3" width="7" height="8" rx="1.5" /><rect x="3" y="15" width="7" height="6" rx="1.5" /><rect x="14" y="15" width="7" height="6" rx="1.5" /><path d="m5.5 7 1 1 1.5-2m8.5 1 1 1 1.5-2" /></svg>;
}

const defaultDifficulty = options => [...options].reverse().find(value => value <= 4) ?? options[0] ?? 0;

export default function MemoryGame({ items, language, favoriteIds, pending, records = {}, storageFailed, onRecordWin, onToggleFavorite, onOpenDetail, onCreativeLab, onRetryImage }) {
  const { t, uiLanguage, errorText } = useI18n();
  const available = useMemo(() => uniqueMemoryItems(items), [items]);
  const options = useMemo(() => availablePairCounts(available), [available]);
  const itemMap = useMemo(() => new Map(available.map(item => [item.id, item])), [available]);
  const [difficulty, setDifficulty] = useState(() => defaultDifficulty(options));
  const [game, setGame] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewUsed, setPreviewUsed] = useState(false);
  const [imageStates, setImageStates] = useState({});
  const [attempts, setAttempts] = useState({});
  const [retrying, setRetrying] = useState(false);
  const [recordFeedback, setRecordFeedback] = useState(null);
  const [inspirationId, setInspirationId] = useState(null);
  const [hidden, setHidden] = useState(() => document.hidden);
  const gameRef = useRef(null);
  const generation = useRef(0);
  const recordedGeneration = useRef(0);
  const mounted = useRef(true);
  const drawnItemsRef = useRef(new Map());
  const currentImageKeys = useRef(new Set());
  const winRef = useRef(null);
  const uniqueIds = useMemo(() => [...new Set(game?.cards.map(card => card.itemId) ?? [])], [game]);
  const drawnItems = uniqueIds.map(id => itemMap.get(id) ?? drawnItemsRef.current.get(id)).filter(Boolean);
  const sources = drawnItems.map(item => ({ item, key: `${generation.current}:${item.id}:${item.image_url ?? ''}:${attempts[item.id] ?? 0}` }));
  currentImageKeys.current = new Set(sources.map(source => source.key));
  const failedSources = sources.filter(source => !source.item.image_url || imageStates[source.key] === 'error');
  const loaded = Boolean(game && sources.length === uniqueIds.length && sources.length > 0 && sources.every(source => imageStates[source.key] === 'loaded'));
  const imageError = Boolean(game && (failedSources.length || sources.length !== uniqueIds.length));
  const imageStatus = !game ? 'idle' : imageError ? 'error' : loaded ? 'loaded' : 'loading';
  const activeDifficulty = game?.pairCount ?? difficulty;
  const best = records?.[activeDifficulty];
  const selectedItem = itemMap.get(inspirationId) ?? drawnItemsRef.current.get(inspirationId);
  const favorite = Boolean(selectedItem && favoriteIds?.has(selectedItem.id));
  const blocked = pending || retrying || hidden || !loaded;
  const status = !game ? 'idle' : imageError ? 'error' : !loaded ? 'loading' : game.status;

  useEffect(() => {
    mounted.current = true;
    const visibilityChanged = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => { mounted.current = false; document.removeEventListener('visibilitychange', visibilityChanged); };
  }, []);

  useEffect(() => {
    if (!options.includes(difficulty)) setDifficulty(defaultDifficulty(options));
  }, [options, difficulty]);

  useEffect(() => {
    if (game?.status !== 'won') return;
    winRef.current?.scrollIntoView({ block: 'nearest' });
    winRef.current?.querySelector('select')?.focus({ preventScroll: true });
  }, [game?.status]);

  // Returning from another app or a pending library operation gives the full viewing delay.
  useEffect(() => {
    if (!game || game.faceUp.length !== 2 || previewing || blocked) return;
    const currentGeneration = generation.current;
    const currentGame = game;
    const timer = window.setTimeout(() => {
      if (document.hidden || currentGeneration !== generation.current || gameRef.current !== currentGame) return;
      const next = resolveMemoryMismatch(currentGame);
      gameRef.current = next;
      setGame(next);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [game, previewing, blocked]);

  useEffect(() => {
    if (!previewing || blocked) return;
    const currentGeneration = generation.current;
    const timer = window.setTimeout(() => {
      if (!document.hidden && generation.current === currentGeneration) setPreviewing(false);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [previewing, blocked]);

  useEffect(() => {
    if (game?.status !== 'won' || recordedGeneration.current === generation.current || !onRecordWin) return;
    const currentGeneration = generation.current;
    recordedGeneration.current = currentGeneration;
    Promise.resolve().then(() => onRecordWin(game.pairCount, game.turns)).then(result => {
      if (!mounted.current || generation.current !== currentGeneration) return;
      setRecordFeedback(result?.ok ? { kind: result.improved ? 'improved' : 'saved' } : { kind: 'error', error: result?.error });
    }).catch(error => {
      if (mounted.current && generation.current === currentGeneration) setRecordFeedback({ kind: 'error', error });
    });
  }, [game, onRecordWin]);

  function start() {
    if (pending || retrying || !options.includes(difficulty)) return;
    const next = createMemoryGame(available, difficulty);
    if (!next) return;
    generation.current += 1;
    drawnItemsRef.current = new Map(available.map(item => [item.id, item]));
    gameRef.current = next;
    setGame(next);
    setImageStates({});
    setAttempts({});
    setPreviewing(false);
    setPreviewUsed(false);
    setRecordFeedback(null);
    setInspirationId(next.cards[0]?.itemId ?? null);
  }

  function flip(key) {
    if (blocked || previewing || gameRef.current?.status !== 'playing') return;
    const next = flipMemoryCard(gameRef.current, key);
    if (next === gameRef.current) return;
    gameRef.current = next;
    setGame(next);
  }

  function preview() {
    if (blocked || previewUsed || game?.turns || game?.faceUp.length || game?.matchedIds.length) return;
    setPreviewUsed(true);
    setPreviewing(true);
  }

  async function retryImages() {
    if (pending || retrying || !failedSources.length) return;
    const currentGeneration = generation.current;
    setRetrying(true);
    try {
      for (const { item } of failedSources) {
        const success = onRetryImage ? await onRetryImage(item) : true;
        if (!mounted.current || generation.current !== currentGeneration) return;
        if (success) setAttempts(previous => ({ ...previous, [item.id]: (previous[item.id] ?? 0) + 1 }));
      }
    } catch { /* The parent retains its inline refresh error and the same drawn cards. */ }
    finally { if (mounted.current && generation.current === currentGeneration) setRetrying(false); }
  }

  function setImageStatus(key, nextStatus) {
    if (!currentImageKeys.current.has(key)) return;
    setImageStates(previous => previous[key] === nextStatus ? previous : { ...previous, [key]: nextStatus });
  }

  const canPreview = Boolean(game && game.status === 'playing' && !previewUsed && !game.turns && !game.faceUp.length && !game.matchedIds.length && !blocked);
  return <section id="memoryGame" className={`memory-game${game ? ' has-game' : ''}`} aria-labelledby="memoryTitle" data-status={status} data-image-state={imageStatus} data-pair-count={game?.pairCount ?? 0} data-previewing={previewing} data-card-order={JSON.stringify(game?.cards ?? [])} onKeyDown={event => event.stopPropagation()}>
    <header className="memory-heading"><span className="memory-mark"><MemoryIcon /></span><div><h3 id="memoryTitle">{t('memory.title')}</h3><p>{t('memory.intro')}</p></div></header>
    <div className="memory-toolbar"><label className="memory-difficulty" htmlFor="memoryDifficulty"><span>{t('memory.difficulty')}</span><select id="memoryDifficulty" value={difficulty || ''} disabled={pending || retrying || !options.length} onChange={event => setDifficulty(Number(event.target.value))}>{options.length ? options.map(count => <option value={count} key={count}>{t('memory.pairs', { count })}</option>) : <option value="">{t('memory.unavailable')}</option>}</select></label><span id="memoryBest" className="memory-best" data-best-turns={best?.turns ?? ''}>{best ? t('memory.best', { count: activeDifficulty, turns: best.turns }) : t('memory.noBest', { count: activeDifficulty || 2 })}</span><button id={game ? 'memoryRestart' : 'memoryStart'} className={game ? 'secondary-button' : 'primary-button'} type="button" disabled={pending || retrying || !options.length} onClick={start}>{t(game ? 'memory.restart' : 'memory.start')}</button></div>
    {!game ? <div className="memory-start"><div className="memory-start-art" aria-hidden="true"><span><MemoryIcon /></span><span>?</span><span><MemoryIcon /></span><span>?</span></div><strong>{t('memory.startHint')}</strong><p>{options.length ? t('memory.available', { count: available.length }) : t('memory.empty')}</p><p className="memory-rules">{t('memory.rules')}</p></div> : <>
      <div className="memory-stats"><div className="memory-score"><output id="memoryTurns" data-turns={game.turns}>{t('memory.turns', { turns: game.turns })}</output><output id="memoryMatched" data-matched={game.matchedIds.length} aria-live="polite" aria-atomic="true">{t('memory.matched', { count: game.matchedIds.length, total: game.pairCount })}</output></div><button id="memoryPreview" className="secondary-button" type="button" disabled={!canPreview} onClick={preview}>{t(previewing ? 'memory.previewing' : previewUsed ? 'memory.previewUsed' : 'memory.preview')}</button></div>
      <div className="memory-preloader" aria-hidden="true">{sources.map(({ item, key }) => <img key={key} src={item.image_url} alt="" onLoad={event => setImageStatus(key, event.currentTarget.naturalWidth && event.currentTarget.naturalHeight ? 'loaded' : 'error')} onError={() => setImageStatus(key, 'error')} />)}</div>
      {!loaded && <div id="memoryImageStatus" className="memory-image-status" role={imageError ? 'alert' : 'status'}><MemoryIcon /><p>{t(imageError ? 'memory.imageError' : 'memory.loading')}</p>{imageError && <button id="memoryRetry" className="secondary-button" type="button" disabled={pending || retrying || !failedSources.length} onClick={retryImages}>{t(retrying ? 'memory.retrying' : 'memory.retry')}</button>}</div>}
      {loaded && <div id="memoryBoard" className={`memory-board pairs-${game.pairCount}`} role="group" aria-label={t('memory.board')} aria-describedby="memoryHint">{game.cards.map((card, index) => {
        const item = itemMap.get(card.itemId) ?? drawnItemsRef.current.get(card.itemId);
        const matched = game.matchedIds.includes(card.itemId);
        const revealed = previewing || matched || game.faceUp.includes(card.key);
        const label = item ? labelFor(item, uiLanguage) || t('memory.imageNumber', { number: portraitNumber(item) }) : '';
        const sourceKey = sources.find(source => source.item.id === card.itemId)?.key;
        return <button key={card.key} className={`memory-card${revealed ? ' is-revealed' : ''}${matched ? ' is-matched' : ''}`} type="button" data-memory-card={card.key} data-item-id={card.itemId} data-revealed={revealed} data-matched={matched} disabled={blocked || previewing || matched || game.faceUp.includes(card.key) || game.faceUp.length === 2 || game.status !== 'playing'} aria-label={revealed ? t(matched ? 'memory.cardMatched' : 'memory.cardRevealed', { position: index + 1, name: label }) : t('memory.cardHidden', { position: index + 1 })} aria-pressed={revealed} onClick={() => flip(card.key)}>{revealed ? <><img src={item?.image_url} alt={label} draggable={false} onError={() => setImageStatus(sourceKey, 'error')} /><span className="memory-card-number" aria-hidden="true">{index + 1}</span>{matched && <span className="memory-card-check" aria-hidden="true">✓</span>}</> : <><span className="memory-card-pattern" aria-hidden="true"><MemoryIcon /></span><span className="memory-card-position" aria-hidden="true">{index + 1}</span></>}</button>;
      })}</div>}
      <p id="memoryHint" className="memory-hint" role="status">{t(previewing ? 'memory.previewHint' : game.status === 'won' ? 'memory.completeHint' : game.faceUp.length === 2 ? 'memory.mismatchHint' : 'memory.playHint')}</p>
      {game.status === 'won' && <section ref={winRef} id="memoryWin" className="memory-win" aria-labelledby="memoryWinTitle"><div className="memory-win-result"><span aria-hidden="true">✦</span><div><h4 id="memoryWinTitle">{t('memory.win')}</h4><p>{t('memory.winScore', { count: game.pairCount, turns: game.turns })}</p></div></div><div className="memory-inspiration"><label htmlFor="memoryInspirationPicker">{t('memory.inspiration')}</label><select id="memoryInspirationPicker" value={inspirationId ?? ''} disabled={pending || retrying} onChange={event => setInspirationId(Number(event.target.value))}>{drawnItems.map(item => <option value={item.id} key={item.id}>{portraitNumber(item)} · {labelFor(item, uiLanguage)}</option>)}</select><div className="memory-win-actions"><button id="memoryFavorite" className="secondary-button" type="button" disabled={pending || retrying || !selectedItem || !onToggleFavorite} aria-pressed={favorite} onClick={() => onToggleFavorite(selectedItem.id)}><StarIcon filled={favorite} />{t(favorite ? 'memory.unfavorite' : 'memory.favorite')}</button><button id="memoryDetails" className="secondary-button" type="button" disabled={pending || retrying || !selectedItem || !onOpenDetail} onClick={() => onOpenDetail(selectedItem)}>{t('memory.details')}</button><button id="memoryCreativeLab" className="secondary-button" type="button" disabled={pending || retrying || !selectedItem || !onCreativeLab} onClick={() => onCreativeLab(selectedItem)}><CreativeLabIcon />{t('memory.creativeLab')}</button></div></div></section>}
    </>}
    {recordFeedback && <p id="memoryRecordFeedback" className={`memory-record-feedback${recordFeedback.kind === 'error' ? ' error' : ''}`} role={recordFeedback.kind === 'error' ? 'alert' : 'status'} data-kind={recordFeedback.kind}>{recordFeedback.kind === 'error' ? `${t('memory.recordFailed')}${recordFeedback.error ? ` ${typeof recordFeedback.error === 'string' && recordFeedback.error.startsWith('memory.') ? t(recordFeedback.error) : errorText(recordFeedback.error)}` : ''}` : t(recordFeedback.kind === 'improved' ? 'memory.newBest' : 'memory.recordSaved')}</p>}
    {storageFailed && <p id="memoryStorageWarning" className="memory-record-feedback error" role="alert">{t('memory.sessionOnly')}</p>}
    {game && <p className="memory-rules">{t('memory.rules')}</p>}
  </section>;
}
