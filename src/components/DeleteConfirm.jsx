import { useEffect, useRef } from 'react';
import { portraitNumber } from '../portraits.js';

export default function DeleteConfirm({ target, pending, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (target && !dialog.open) dialog.showModal();
    else if (!target && dialog.open) dialog.close();
  }, [target]);
  return <dialog ref={dialogRef} id="deleteConfirmDialog" className="management-dialog delete-dialog" aria-labelledby="deleteConfirmTitle" onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <div className="management-heading"><div><div className="detail-kicker">LOCAL PORTRAIT</div><h2 id="deleteConfirmTitle">移到系统废纸篓？</h2></div></div>
    <div className="delete-object">{target ? `${portraitNumber(target.item)} · ${target.item.label}` : ''}</div>
    <p className="delete-description">这张图片将从素材库移除，并移到 macOS 废纸篓。关联中英提示词和恢复记录将保留在本地素材目录；图片可从废纸篓找回。</p>
    {target?.error && <div id="deleteError" className="form-error" role="alert">{target.error}</div>}
    <div className="management-actions"><button id="deleteCancel" className="secondary-button" type="button" disabled={pending} onClick={onCancel}>取消</button><button id="deleteConfirm" className="danger-button" type="button" disabled={pending || target?.conflicted} onClick={onConfirm}>{pending ? '正在移到废纸篓…' : '确认移到废纸篓'}</button></div>
  </dialog>;
}
