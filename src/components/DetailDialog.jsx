import { useEffect, useRef } from 'react';
import { portraitNumber, promptFor, labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
export default function DetailDialog({ item, total, language, onClose, onCopy, onOpenImage, onCycle, canManage, pending, onEdit, onDelete }) {
  const { t, uiLanguage } = useI18n();
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (item && !dialog.open) dialog.showModal();
    else if (!item && dialog.open) dialog.close();
  }, [item]);
  return <dialog ref={dialogRef} className="detail-dialog" id="detailDialog" aria-labelledby="detailTitle" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !pending) onClose(); }} onKeyDown={event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); onCycle(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); onCycle(1); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); onCopy(item); }
  }}>
    <div className="detail-layout">
      <div className="detail-image-wrap"><img id="detailImage" src={item?.image_url} alt={item?.label ?? ''} /><div className="detail-index" id="detailIndex">{item ? `${portraitNumber(item)} / ${String(total).padStart(3, '0')}` : ''}</div></div>
      <div className="detail-copy">
        <button className="dialog-close" id="closeDialog" type="button" aria-label={t('detail.close')} disabled={pending} onClick={onClose}>×</button>
        <div className="detail-kicker" id="detailKicker">{item ? t('detail.kicker') : ''}</div><h2 id="detailTitle">{labelFor(item, uiLanguage)}</h2>
        <div className="detail-intro"><span>{t('detail.intro')}</span></div><div className="prompt-box"><pre id="detailPrompt" lang={language === 'zh' ? 'zh-CN' : 'en'}>{promptFor(item, language)}</pre></div>
        <div className="detail-actions"><button className="primary-button" id="detailCopy" type="button" onClick={() => onCopy(item)}><span>⧉</span> {t('detail.copy')}</button><button className="secondary-button" id="detailOpen" type="button" onClick={() => onOpenImage(item)}>{t('detail.openImage')}</button></div>
        {canManage && <div className="detail-management"><button className="text-button" id="detailEdit" type="button" disabled={pending} onClick={() => onEdit(item)}>{t('detail.edit')}</button><button className="text-button danger-text" id="detailDelete" type="button" disabled={pending} onClick={() => onDelete(item)}>{t('detail.trash')}</button></div>}
        <div className="detail-hint">{t('detail.shortcuts')}</div>
      </div>
    </div>
  </dialog>;
}
