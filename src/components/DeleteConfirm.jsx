import { useEffect, useRef } from 'react';
import { portraitNumber } from '../portraits.js';
import { useI18n } from '../i18n.jsx';

export default function DeleteConfirm({ target, pending, onCancel, onConfirm }) {
  const { t, errorText } = useI18n();
  const isBatch = Boolean(target?.ids);
  const preview = target?.preview === true;
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (target && !dialog.open) dialog.showModal();
    else if (!target && dialog.open) dialog.close();
  }, [target]);
  return <dialog ref={dialogRef} id="deleteConfirmDialog" className="management-dialog delete-dialog" aria-labelledby="deleteConfirmTitle" onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <div className="management-heading"><div><div className="detail-kicker">{t('common.localPortrait')}</div><h2 id="deleteConfirmTitle">{t(isBatch ? 'delete.batchTitle' : 'delete.title')}</h2></div></div>
    <div className="delete-object">{target ? (isBatch ? t('delete.batchObject', { count: target.count }) : `${portraitNumber(target.item)} · ${target.item.label}`) : ''}</div>
    <p className="delete-description">{t(preview ? 'delete.previewDescription' : isBatch ? 'delete.batchDescription' : 'delete.description')}</p>
    {target?.error && <div id="deleteError" className="form-error" role="alert">{errorText(target.error)}</div>}
    <div className="management-actions"><button id="deleteCancel" className="secondary-button" type="button" disabled={pending} onClick={onCancel}>{t('common.cancel')}</button><button id="deleteConfirm" className="danger-button" type="button" disabled={pending || target?.conflicted} onClick={onConfirm}>{t(preview ? pending ? 'delete.previewPending' : 'delete.previewConfirm' : pending ? 'delete.pending' : 'delete.confirm')}</button></div>
  </dialog>;
}
