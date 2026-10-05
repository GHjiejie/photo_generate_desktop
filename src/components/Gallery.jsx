import { portraitNumber, labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
function PortraitCard({ item, index, copied, onOpen, onCopy, selected, onToggleSelect, batchMode, pending }) {
  const { t, uiLanguage } = useI18n();
  const name = labelFor(item, uiLanguage);
  function activate() { if (!pending) { if (batchMode) onToggleSelect(item.id); else onOpen(item.id); } }
  return <article className={`portrait-card${selected ? ' selected' : ''}`} data-id={item.id} tabIndex={0} aria-label={`${portraitNumber(item)} ${name}`} onClick={activate} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); onCopy(item, true); }
  }}>
    <div className="portrait-image-wrap">
      <img className="portrait-image" loading={index < 5 ? 'eager' : 'lazy'} src={item.image_url} alt={`${name} · ${portraitNumber(item)}`} />
      {batchMode && <input type="checkbox" className="select-checkbox" checked={selected} disabled={pending} onClick={event => event.stopPropagation()} onChange={() => onToggleSelect(item.id)} aria-label={t('gallery.selectNamed', { name })} />}
      <button className={`copy-button${copied ? ' copied' : ''}`} type="button" title={t('gallery.copyPrompt')} aria-label={t('gallery.copyNamedPrompt', { name })} onClick={event => { event.stopPropagation(); onCopy(item, true); }}>{copied ? '✓' : '⧉'}</button>
    </div>
    <div className="card-overlay" aria-hidden="true" />
  </article>;
}
export default function Gallery({ items, dense, copiedId, onOpen, onCopy, configured = false, query = '', selectedIds = new Set(), onToggleSelect, onBatchDelete, batchMode = false, canBatchDelete = false, pending = false, onBeginSelection, onEndSelection, onToggleVisible, onClearSelection }) {
  const { t } = useI18n();
  const allVisibleSelected = items.length > 0 && items.every(item => selectedIds.has(item.id));
  const hiddenSelected = selectedIds.size - items.filter(item => selectedIds.has(item.id)).length;
  return <>
    <div className="toolbar"><div className="result-count" id="resultCount">{t('gallery.resultCount', { count: items.length })}</div>
      {batchMode ? <div className="batch-actions" role="group" aria-label={t('gallery.batchDelete')}>
        <span id="selectedCount" className="selected-count" role="status">{t('gallery.selectedCount', { count: selectedIds.size })}{hiddenSelected > 0 ? ` · ${t('gallery.hiddenSelected', { count: hiddenSelected })}` : ''}</span>
        <button id="selectVisible" className="batch-action-button" type="button" disabled={pending || !items.length} onClick={onToggleVisible}>{t(allVisibleSelected ? 'gallery.deselectVisible' : 'gallery.selectVisible')}</button>
        <button id="clearSelection" className="batch-action-button" type="button" disabled={pending || !selectedIds.size} onClick={onClearSelection}>{t('gallery.clearSelection')}</button>
        <button id="batchDeleteSelected" className="batch-delete-button" type="button" disabled={pending || !canBatchDelete || selectedIds.size === 0} onClick={onBatchDelete}>{t('gallery.deleteSelected')}</button>
        <button id="exitSelection" className="batch-action-button" type="button" disabled={pending} onClick={onEndSelection}>{t('gallery.exitSelection')}</button>
      </div> : canBatchDelete && <button id="beginBatchDelete" className="batch-action-button" type="button" disabled={pending || !items.length} onClick={onBeginSelection}>{t('gallery.batchDelete')}</button>}
    </div>
    <section className={`gallery${dense ? ' dense' : ''}`} id="gallery" aria-live="polite">
      {items.map((item, index) => <PortraitCard key={item.id} item={item} index={index} copied={copiedId === item.id} onOpen={onOpen} onCopy={onCopy} selected={selectedIds.has(item.id)} onToggleSelect={onToggleSelect} batchMode={batchMode} pending={pending} />)}
    </section>
    <div className="empty-state" id="emptyState" hidden={items.length !== 0}>
      <div className="empty-visual" aria-hidden="true" />
      <h3 id="emptyTitle">{t(!configured ? 'gallery.chooseFolder' : query ? 'gallery.noResults' : 'gallery.emptyTitle')}</h3>
      <p id="emptyText">{t(!configured ? 'gallery.chooseFolderHint' : query ? 'gallery.noResultsHint' : 'gallery.emptyHint')}</p>
      <p className="empty-query" hidden={!query}>{query ? t('gallery.emptyQuery', { query }) : ''}</p>
    </div>
  </>;
}
