import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { labelFor, portraitNumber } from '../portraits.js';
import { chooseDuelWinner, createDuel, currentDuelPair, drawDuelItems, uniqueDuelItems } from '../inspiration-duel.mjs';
import './inspiration-duel.css';

export function DuelIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m4 3 5 2 11 13-3 3L6 8 4 3Zm16 0-5 2-4 5M4 18l5-6m-5 5-2 2m4 2-3-3m14-4 3 3m-3 4 5-5" /></svg>;
}

function TrophyIcon() {
  return <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M7 3h10v5a5 5 0 0 1-10 0V3Zm0 2H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4m-4 2v5m-4 3h8m-6-3h4v3h-4v-3Z" /></svg>;
}

export default function InspirationDuel({ items, favoriteIds, pending, onToggleFavorite, onOpenDetail, onCreativeLab }) {
  const { t, uiLanguage } = useI18n();
  const available = useMemo(() => uniqueDuelItems(items), [items]);
  const [{ duel, history }, setSession] = useState({ duel: null, history: [] });
  const firstActionRef = useRef(null);
  const pair = currentDuelPair(duel);
  const winner = duel?.winner;
  const isFavorite = winner && Boolean(favoriteIds?.has(winner.id));
  const canStart = !pending && available.length >= 2;

  useEffect(() => {
    if (duel) firstActionRef.current?.focus({ preventScroll: true });
  }, [duel]);

  function start() {
    if (!canStart) return;
    setSession({ duel: createDuel(drawDuelItems(available)), history: [] });
  }
  function pick(id) {
    if (pending) return;
    setSession(previous => {
      // An old button event cannot accidentally vote in the following match.
      if (previous.duel !== duel) return previous;
      const next = chooseDuelWinner(previous.duel, id);
      return next === previous.duel ? previous : { duel: next, history: [...previous.history, previous.duel] };
    });
  }
  function undo() {
    if (pending) return;
    setSession(previous => previous.history.length ? { duel: previous.history.at(-1), history: previous.history.slice(0, -1) } : previous);
  }

  return <section className={`inspiration-duel${winner ? ' has-winner' : ''}`} aria-labelledby="duelTitle">
    <div className="duel-heading"><span className="duel-mark"><DuelIcon /></span><div><h3 id="duelTitle">{t('duel.title')}</h3><p>{t('duel.intro')}</p></div></div>
    {!duel ? <div className="duel-start-screen">
      <div className="duel-start-art" aria-hidden="true"><span /><DuelIcon /><span /></div>
      <strong>{t('duel.startHint')}</strong><p>{available.length >= 2 ? t('duel.available', { count: available.length }) : t('duel.empty')}</p>
      <button id="duelStart" className="primary-button" type="button" disabled={!canStart} onClick={start}>{t('duel.start')}</button>
    </div> : <>
      <div className="duel-status"><span id="duelRound">{duel.entrants.length <= 2 ? t('duel.finalRound') : t('duel.round', { round: duel.round })}</span><span id="duelProgress" aria-live="polite" aria-atomic="true">{t('duel.progress', { done: duel.completedMatches, total: duel.totalMatches })}</span></div>
      <progress className="duel-progress-bar" value={duel.completedMatches} max={duel.totalMatches} aria-label={t('duel.progress', { done: duel.completedMatches, total: duel.totalMatches })} />
      {pair && <>
        <p className="duel-choose-hint">{t('duel.chooseHint')}</p>
        <div className="duel-pair">{pair.map((item, index) => <article className="duel-card" key={item.id} data-duel-card={item.id}>
          <div className="duel-image"><img src={item.image_url} alt={labelFor(item, uiLanguage)} /></div>
          <div className="duel-card-caption"><span>{portraitNumber(item)}</span><h4 title={labelFor(item, uiLanguage)}>{labelFor(item, uiLanguage)}</h4></div>
          <button ref={index === 0 ? firstActionRef : null} className="primary-button duel-pick" type="button" data-duel-pick={item.id} disabled={pending} aria-label={`${t(index === 0 ? 'duel.pickLeft' : 'duel.pickRight')} · ${t('duel.pickNamed', { name: labelFor(item, uiLanguage) })}`} onClick={() => pick(item.id)}>{t(index === 0 ? 'duel.pickLeft' : 'duel.pickRight')}</button>
        </article>)}</div>
      </>}
      {winner && <div id="duelWinner" className="duel-winner" data-winner-id={winner.id}>
        <div className="duel-winner-image"><img src={winner.image_url} alt={labelFor(winner, uiLanguage)} /></div>
        <div className="duel-winner-summary"><span className="duel-trophy"><TrophyIcon /></span><h4>{t('duel.winner')}</h4><strong>{portraitNumber(winner)} · {labelFor(winner, uiLanguage)}</strong><p>{t('duel.winnerHint')}</p>
          <div className="duel-winner-actions"><button ref={firstActionRef} id="duelFavorite" className="primary-button" type="button" aria-pressed={Boolean(isFavorite)} disabled={pending} onClick={() => onToggleFavorite(winner.id)}><span aria-hidden="true">{isFavorite ? '♥' : '♡'}</span>{t(isFavorite ? 'duel.unfavorite' : 'duel.favorite')}</button><button id="duelOpenDetail" className="secondary-button" type="button" disabled={pending} onClick={() => onOpenDetail(winner)}>{t('duel.openDetail')}</button><button id="duelCreativeLab" className="secondary-button" type="button" disabled={pending} onClick={() => onCreativeLab(winner)}>{t('duel.creativeLab')}</button></div>
        </div>
      </div>}
      <footer className="duel-footer"><span>{pair && duel.entrants.length % 2 ? t('duel.byeHint') : ''}</span><div><button id="duelUndo" className="secondary-button" type="button" disabled={pending || !history.length} onClick={undo}>{t('duel.undo')}</button><button id="duelRestart" className="secondary-button" type="button" disabled={!canStart} onClick={start}>{t('duel.restart')}</button></div></footer>
    </>}
  </section>;
}
