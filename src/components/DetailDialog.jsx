import { useEffect, useRef } from 'react';
import { portraitNumber } from '../portraits.js';
export default function DetailDialog({ item, total, onClose, onCopy, onOpenImage, onCycle }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (item && !dialog.open) dialog.showModal();
    else if (!item && dialog.open) dialog.close();
  }, [item]);
  return <dialog ref={dialogRef} className="detail-dialog" id="detailDialog" aria-labelledby="detailTitle" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); onCycle(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); onCycle(1); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); onCopy(item); }
  }}>
    <div className="detail-layout">
      <div className="detail-image-wrap"><img id="detailImage" src={item?.image_url} alt={item?.label ?? ''} /><div className="detail-index" id="detailIndex">{item ? `${portraitNumber(item)} / ${String(total).padStart(3, '0')}` : ''}</div></div>
      <div className="detail-copy">
        <button className="dialog-close" id="closeDialog" type="button" aria-label="关闭详情" onClick={onClose}>×</button>
        <div className="detail-kicker" id="detailKicker">{item ? 'FULL PROMPT' : ''}</div><h2 id="detailTitle">{item?.label}</h2>
        <p className="detail-intro">这张图片的完整生成提示词</p><div className="prompt-box"><pre id="detailPrompt">{item?.prompt}</pre></div>
        <div className="detail-actions"><button className="primary-button" id="detailCopy" type="button" onClick={() => onCopy(item)}><span>⧉</span> 复制完整提示词</button><button className="secondary-button" id="detailOpen" type="button" onClick={() => onOpenImage(item)}>打开原图</button></div>
        <div className="detail-hint">快捷键：⌘ Enter 复制 · Esc 关闭 · ← → 切换</div>
      </div>
    </div>
  </dialog>;
}
