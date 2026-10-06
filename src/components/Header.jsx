import { useI18n } from '../i18n.jsx';
import LibraryMenu from './LibraryMenu.jsx';
import { ShuffleIcon } from './FavoriteButton.jsx';
import { CompareIcon } from './Compare.jsx';
import { CreativeLabIcon } from './CreativeLab.jsx';
export default function Header({ query, onQuery, searchRef, batchMode = false, dense, onToggleDensity, onRandom, randomDisabled, onCompare, compareCount, compareDisabled, onCreativeLab, creativeDisabled, library, desktop, connected, editable, pending, onConfigure, onRefresh, onCreate, onBatch, onProcess, canBatchDelete, onSelect }) {
  const { t } = useI18n();
  return <header className="topbar">
    <div className="search-actions"><div className="search-box"><svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input ref={searchRef} id="searchInput" type="search" aria-label={t('header.search')} placeholder={t('header.search')} autoComplete="off" value={query} onChange={event => onQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query && !batchMode) { event.preventDefault(); onQuery(''); } }} />{query ? <button id="clearSearch" className="search-clear" type="button" aria-label={t('browse.clearSearch')} title={t('browse.clearSearch')} onClick={() => { onQuery(''); searchRef.current?.focus(); }}>×</button> : <kbd>⌘ K</kbd>}</div>
    <button className={`icon-button${dense ? ' active' : ''}`} id="gridToggle" type="button" aria-label={t('header.density')} aria-pressed={dense} title={t('header.density')} onClick={onToggleDensity}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg></button>
    <button id="randomInspiration" className="inspiration-button" type="button" disabled={randomDisabled} title={t('favorites.randomHint')} onClick={onRandom}><ShuffleIcon /><span>{t('favorites.random')}</span></button>
    <button id="compareToggle" className="icon-button compare-toggle" type="button" disabled={compareDisabled} aria-label={t('compare.header', { count: compareCount })} title={t(compareCount < 2 ? 'compare.pickHint' : 'compare.open')} onClick={onCompare}><CompareIcon />{compareCount > 0 && <span className="compare-badge" aria-hidden="true">{compareCount}</span>}</button>
    <button id="openCreativeLab" className="icon-button creative-lab-trigger" type="button" disabled={creativeDisabled} aria-label={t('lab.open')} title={t('lab.open')} onClick={onCreativeLab}><CreativeLabIcon /></button></div>
    <LibraryMenu library={library} desktop={desktop} connected={connected} editable={editable} pending={pending} onConfigure={onConfigure} onRefresh={onRefresh} onCreate={onCreate} onBatch={onBatch} onProcess={onProcess} canBatchDelete={canBatchDelete} onSelect={onSelect} />
  </header>;
}
