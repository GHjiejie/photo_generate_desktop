import { portraitNumber, labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
import FavoriteButton from './FavoriteButton.jsx';
import { CompareButton } from './Compare.jsx';
import './browse.css';
function PortraitCard({ item, index, copied, onOpen, onCopy, selected, onToggleSelect, batchMode, pending, favorite, favoritesAvailable, onToggleFavorite, comparing, canCompare, onToggleCompare }) {
  const { t, uiLanguage } = useI18n();
  const name = labelFor(item, uiLanguage);
  function activate() { if (!pending) { if (batchMode) onToggleSelect(item.id); else onOpen(item.id); } }
  return <article className={`portrait-card${selected ? ' selected' : ''}${comparing ? ' comparing' : ''}`} data-id={item.id} tabIndex={0} aria-label={`${portraitNumber(item)} ${name}`} onClick={activate} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); onCopy(item, true); }
  }}>
    <div className="portrait-image-wrap">
      <img className="portrait-image" loading={index < 5 ? 'eager' : 'lazy'} src={item.image_url} alt={`${name} · ${portraitNumber(item)}`} />
      {batchMode && <input type="checkbox" className="select-checkbox" checked={selected} disabled={pending} onClick={event => event.stopPropagation()} onChange={() => onToggleSelect(item.id)} aria-label={t('gallery.selectNamed', { name })} />}
      {!batchMode && favoritesAvailable && <FavoriteButton item={item} favorite={favorite} disabled={pending} onToggle={onToggleFavorite} />}
      {!batchMode && canCompare && <CompareButton item={item} selected={comparing} disabled={pending} onToggle={onToggleCompare} />}
      <button className={`copy-button${copied ? ' copied' : ''}`} type="button" title={t('gallery.copyPrompt')} aria-label={t('gallery.copyNamedPrompt', { name })} onClick={event => { event.stopPropagation(); onCopy(item, true); }}>{copied ? '✓' : '⧉'}</button>
    </div>
    <div className="card-overlay" aria-hidden="true" />
  </article>;
}
export default function Gallery({ items, dense, copiedId, onOpen, onCopy, configured = false, query = '', sort = 'default', onSort, activeTagName = '', onClearQuery, onClearTag, onClearFavorites, favoriteIds = new Set(), favoritesOnly = false, favoritesAvailable = false, onToggleFavorite, onShowAll, tagFiltered = false, onResetFilters, comparisonIds = [], canCompare = false, onToggleCompare, selectedIds = new Set(), onToggleSelect, onBatchDelete, batchMode = false, canBatchDelete = false, pending = false, onBeginSelection, onEndSelection, onToggleVisible, onClearSelection }) {
  const { t } = useI18n();
  const allVisibleSelected = items.length > 0 && items.every(item => selectedIds.has(item.id));
  const hiddenSelected = selectedIds.size - items.filter(item => selectedIds.has(item.id)).length;
  const hasQuery = Boolean(query.trim());
  const emptyTitle = !configured ? 'gallery.chooseFolder' : tagFiltered ? 'tags.noResults' : `${favoritesOnly ? 'favorites' : 'gallery'}.${hasQuery ? 'noResults' : 'emptyTitle'}`;
  const emptyHint = !configured ? 'gallery.chooseFolderHint' : tagFiltered ? 'tags.noResultsHint' : `${favoritesOnly ? 'favorites' : 'gallery'}.${hasQuery ? 'noResultsHint' : 'emptyHint'}`;
  return <>
    <div className="toolbar"><div className="browse-controls"><div className="result-count" id="resultCount">{t('gallery.resultCount', { count: items.length })}</div>
      <label className="gallery-sort" htmlFor="gallerySort"><span>{t('browse.sort')}</span><select id="gallerySort" value={sort} disabled={pending || !configured} onChange={event => onSort(event.target.value)}>
        <option value="default">{t('browse.sortDefault')}</option><option value="number-desc">{t('browse.sortNumberDesc')}</option><option value="name-asc">{t('browse.sortName')}</option>
      </select></label></div>
      {batchMode ? <div className="batch-actions" role="group" aria-label={t('gallery.batchDelete')}>
        <span id="selectedCount" className="selected-count" role="status">{t('gallery.selectedCount', { count: selectedIds.size })}{hiddenSelected > 0 ? ` · ${t('gallery.hiddenSelected', { count: hiddenSelected })}` : ''}</span>
        <button id="selectVisible" className="batch-action-button" type="button" disabled={pending || !items.length} onClick={onToggleVisible}>{t(allVisibleSelected ? 'gallery.deselectVisible' : 'gallery.selectVisible')}</button>
        <button id="clearSelection" className="batch-action-button" type="button" disabled={pending || !selectedIds.size} onClick={onClearSelection}>{t('gallery.clearSelection')}</button>
        <button id="batchDeleteSelected" className="batch-delete-button" type="button" disabled={pending || !canBatchDelete || selectedIds.size === 0} onClick={onBatchDelete}>{t('gallery.deleteSelected')}</button>
        <button id="exitSelection" className="batch-action-button" type="button" disabled={pending} onClick={onEndSelection}>{t('gallery.exitSelection')}</button>
      </div> : canBatchDelete && <button id="beginBatchDelete" className="batch-action-button" type="button" disabled={pending || !items.length} onClick={onBeginSelection}>{t('gallery.batchDelete')}</button>}
    </div>
    {(hasQuery || favoritesOnly || tagFiltered) && <div className="browse-filters" role="group" aria-label={t('browse.activeFilters')}>
      {hasQuery && <button id="clearSearchFilter" className="browse-filter-chip" type="button" disabled={pending} title={query} aria-label={t('browse.removeSearch', { query })} onClick={onClearQuery}><span>{t('browse.searchFilter', { query })}</span><span aria-hidden="true">×</span></button>}
      {favoritesOnly && <button id="clearFavoriteFilter" className="browse-filter-chip" type="button" disabled={pending} aria-label={t('browse.removeFavorites')} onClick={onClearFavorites}><span>{t('favorites.view')}</span><span aria-hidden="true">×</span></button>}
      {tagFiltered && <button id="clearBrowseTagFilter" className="browse-filter-chip" type="button" disabled={pending} title={activeTagName} aria-label={t('browse.removeTag', { name: activeTagName })} onClick={onClearTag}><span>{t('browse.tagFilter', { name: activeTagName })}</span><span aria-hidden="true">×</span></button>}
      <button id="resetBrowseFilters" className="text-button" type="button" disabled={pending} onClick={onResetFilters}>{t('browse.clearFilters')}</button>
    </div>}
    <section className={`gallery${dense ? ' dense' : ''}`} id="gallery" aria-live="polite">
      {items.map((item, index) => <PortraitCard key={item.id} item={item} index={index} copied={copiedId === item.id} onOpen={onOpen} onCopy={onCopy} selected={selectedIds.has(item.id)} onToggleSelect={onToggleSelect} batchMode={batchMode} pending={pending} favorite={favoriteIds.has(item.id)} favoritesAvailable={favoritesAvailable} onToggleFavorite={onToggleFavorite} comparing={comparisonIds.includes(item.id)} canCompare={canCompare} onToggleCompare={onToggleCompare} />)}
    </section>
    <div className="empty-state" id="emptyState" hidden={items.length !== 0}>
      <div className="empty-visual" aria-hidden="true" />
      <h3 id="emptyTitle">{t(emptyTitle)}</h3>
      <p id="emptyText">{t(emptyHint)}</p>
      <p className="empty-query" hidden={!hasQuery}>{hasQuery ? t('gallery.emptyQuery', { query }) : ''}</p>
      {configured && tagFiltered && <button id="resetGalleryFilters" className="secondary-button" type="button" disabled={pending} onClick={onResetFilters}>{t('tags.resetFilters')}</button>}
      {configured && favoritesOnly && !tagFiltered && <button id="showAllImages" className="secondary-button" type="button" disabled={pending} onClick={onShowAll}>{t('favorites.showAll')}</button>}
    </div>
  </>;
}
