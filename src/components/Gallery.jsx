import { portraitNumber, labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
function PortraitCard({ item, index, copied, onOpen, onCopy }) {
  const { t, uiLanguage } = useI18n();
  const name = labelFor(item, uiLanguage);
  return <article className="portrait-card" data-id={item.id} tabIndex={0} aria-label={`${portraitNumber(item)} ${name}`} onClick={() => onOpen(item.id)} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item.id); }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); onCopy(item, true); }
  }}>
    <div className="portrait-image-wrap">
      <img className="portrait-image" loading={index < 5 ? 'eager' : 'lazy'} src={item.image_url} alt={`${name} · ${portraitNumber(item)}`} />
      <button className={`copy-button${copied ? ' copied' : ''}`} type="button" title={t('gallery.copyPrompt')} aria-label={t('gallery.copyNamedPrompt', { name })} onClick={event => { event.stopPropagation(); onCopy(item, true); }}>{copied ? '✓' : '⧉'}</button>
    </div>
    <div className="card-overlay" aria-hidden="true" />
  </article>;
}
export default function Gallery({ items, dense, copiedId, onOpen, onCopy, configured = false, query = '' }) {
  const { t } = useI18n();
  return <>
    <div className="toolbar"><div className="result-count" id="resultCount">{t('gallery.resultCount', { count: items.length })}</div></div>
    <section className={`gallery${dense ? ' dense' : ''}`} id="gallery" aria-live="polite">
      {items.map((item, index) => <PortraitCard key={item.id} item={item} index={index} copied={copiedId === item.id} onOpen={onOpen} onCopy={onCopy} />)}
    </section>
    <div className="empty-state" id="emptyState" hidden={items.length !== 0}><div className="empty-symbol">⌁</div><h2>{t(!configured ? 'gallery.chooseFolder' : !query ? 'gallery.emptyTitle' : 'gallery.noResults')}</h2><p>{t(!configured ? 'gallery.chooseFolderHint' : !query ? 'gallery.emptyHint' : 'gallery.noResultsHint')}</p></div>
  </>;
}
