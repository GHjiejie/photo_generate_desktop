import { useEffect, useRef, useState } from 'react';
import { portraitNumber, promptFor, labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
import FavoriteButton, { ShuffleIcon } from './FavoriteButton.jsx';
import ImageTags from './ImageTags.jsx';
import { CompareButton } from './Compare.jsx';
import { CreativeLabIcon } from './CreativeLab.jsx';
import ImageViewer, { ViewImageIcon } from './ImageViewer.jsx';
export default function DetailDialog({ item, position = 0, total, language, onClose, onCopy, onOpenImage, onCycle, canManage, pending, onEdit, onDelete, favorite, favoritesAvailable, onToggleFavorite, onRandom, randomDisabled, tags = [], catalog = [], onTagsChange, comparing, canCompare, onToggleCompare, onCreativeLab, creativeDisabled }) {
  const { t, uiLanguage } = useI18n();
  const dialogRef = useRef(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (item && !dialog.open) dialog.showModal();
    else if (!item && dialog.open) dialog.close();
  }, [item]);
  useEffect(() => { setViewerOpen(false); }, [item?.id, item?.image_url]);
  const cycleDisabled = pending || total === 0 || (total === 1 && position > 0);
  return <><dialog ref={dialogRef} className="detail-dialog" id="detailDialog" aria-labelledby="detailTitle" onCancel={event => { event.preventDefault(); if (!pending && !viewerOpen) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !pending && !viewerOpen) onClose(); }} onKeyDown={event => {
    if (viewerOpen || pending || event.target.isContentEditable || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if (event.key === 'ArrowLeft' && !cycleDisabled) { event.preventDefault(); onCycle(-1); }
    if (event.key === 'ArrowRight' && !cycleDisabled) { event.preventDefault(); onCycle(1); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); onCopy(item); }
  }}>
    <div className="detail-layout">
      <div className="detail-image-wrap"><img id="detailImage" src={item?.image_url} alt={labelFor(item, uiLanguage)} /><div className="detail-index" id="detailIndex">{item ? portraitNumber(item) : ''}</div>
        {item && <div className="detail-image-actions">
          <button id="detailViewer" className="image-action-button" type="button" disabled={pending} title={t('viewer.open')} aria-label={t('viewer.open')} onClick={() => setViewerOpen(true)}><ViewImageIcon /></button>
          {favoritesAvailable && <FavoriteButton item={item} favorite={favorite} disabled={pending} onToggle={onToggleFavorite} />}
          <button id="detailRandom" className="image-action-button" type="button" disabled={randomDisabled} title={t('favorites.randomHint')} aria-label={t('favorites.random')} onClick={onRandom}><ShuffleIcon /></button>
          {canCompare && <CompareButton item={item} selected={comparing} disabled={pending} onToggle={onToggleCompare} />}
          <button id="detailCreativeLab" className="image-action-button" type="button" disabled={creativeDisabled} title={t('lab.remixThis')} aria-label={t('lab.remixThis')} onClick={() => onCreativeLab(item)}><CreativeLabIcon /></button>
        </div>}
        {item && <nav className="detail-browse" aria-label={t('browse.navigation')}>
          <button id="detailPrevious" type="button" disabled={cycleDisabled} aria-label={t('browse.previous')} title={t('browse.previous')} onClick={() => onCycle(-1)}><span aria-hidden="true">‹</span><span className="detail-browse-label">{t('browse.previous')}</span></button>
          <span id="detailPosition" className="detail-position" aria-live="polite">{position > 0 ? t('browse.position', { position, total }) : t('browse.positionOutside')}</span>
          <button id="detailNext" type="button" disabled={cycleDisabled} aria-label={t('browse.next')} title={t('browse.next')} onClick={() => onCycle(1)}><span className="detail-browse-label">{t('browse.next')}</span><span aria-hidden="true">›</span></button>
        </nav>}
      </div>
      <div className="detail-copy">
        <button className="dialog-close" id="closeDialog" type="button" aria-label={t('detail.close')} disabled={pending} onClick={onClose}>×</button>
        <div className="detail-kicker" id="detailKicker">{item ? t('detail.kicker') : ''}</div><h2 id="detailTitle">{labelFor(item, uiLanguage)}</h2>
        <div className="detail-intro"><span>{t('detail.intro')}</span></div>
        {item && favoritesAvailable && <ImageTags key={item.id} item={item} tags={tags} catalog={catalog} disabled={pending} onChange={onTagsChange} />}
        <div className="prompt-box"><pre id="detailPrompt" lang={language === 'zh' ? 'zh-CN' : 'en'}>{promptFor(item, language)}</pre></div>
        <div className="detail-actions"><button className="primary-button" id="detailCopy" type="button" onClick={() => onCopy(item)}><span>⧉</span> {t('detail.copy')}</button><button className="secondary-button" id="detailOpen" type="button" onClick={() => onOpenImage(item)}>{t('detail.openImage')}</button></div>
        {canManage && <div className="detail-management"><button className="text-button" id="detailEdit" type="button" disabled={pending} onClick={() => onEdit(item)}>{t('detail.edit')}</button><button className="text-button danger-text" id="detailDelete" type="button" disabled={pending} onClick={() => onDelete(item)}>{t('detail.trash')}</button></div>}
        <div className="detail-hint">{t('detail.shortcuts')}</div>
      </div>
    </div>
  </dialog>{viewerOpen && item && <ImageViewer key={`${item.id}:${item.image_url}`} item={item} onClose={() => setViewerOpen(false)} />}</>;
}
