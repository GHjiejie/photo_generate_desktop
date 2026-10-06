import { useEffect, useRef, useState } from 'react';
import { labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
import './image-viewer.css';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const constrainOffset = (offset, image, viewport, scale) => {
  const limitX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const limitY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { x: clamp(offset.x, -limitX, limitX), y: clamp(offset.y, -limitY, limitY) };
};

export function ViewImageIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" /><path d="m8 16 3-4 3 3 2-3 2 4" /><circle cx="9" cy="8" r="1" /></svg>;
}

export default function ImageViewer({ item, onClose }) {
  const { t, uiLanguage } = useI18n();
  const dialogRef = useRef(null);
  const viewportRef = useRef(null);
  const dragRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const [requestedScale, setRequestedScale] = useState(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const label = labelFor(item, uiLanguage);
  const ready = status === 'loaded' && viewport.width > 0 && viewport.height > 0;
  const fitScale = ready ? Math.min(1, viewport.width / imageSize.width, viewport.height / imageSize.height) : 1;
  const scale = requestedScale ?? fitScale;
  const minimumScale = fitScale / 4;
  const maximumScale = 8;
  const canPan = ready && (imageSize.width * scale > viewport.width + 1 || imageSize.height * scale > viewport.height + 1);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setOffset(current => {
      const next = constrainOffset(current, imageSize, viewport, scale);
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, [imageSize, viewport, scale]);

  const changeScale = value => {
    if (!ready) return;
    setRequestedScale(clamp(value, minimumScale, maximumScale));
  };
  const fit = () => { setRequestedScale(null); setOffset({ x: 0, y: 0 }); };
  const finishDrag = event => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const retry = () => {
    setStatus('loading'); setImageSize({ width: 0, height: 0 }); fit(); setAttempt(value => value + 1);
  };

  return <dialog ref={dialogRef} id="imageViewer" className="image-viewer" aria-labelledby="imageViewerTitle" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeScale(scale * 1.25); }
    else if (event.key === '-') { event.preventDefault(); changeScale(scale / 1.25); }
    else if (event.key === '0') { event.preventDefault(); fit(); }
    else if (canPan && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const step = event.shiftKey ? 120 : 40;
      setOffset(current => constrainOffset({ x: current.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0), y: current.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0) }, imageSize, viewport, scale));
    }
  }}>
    <div className="image-viewer-header">
      <h2 id="imageViewerTitle">{t('viewer.title', { label })}</h2>
      <button id="viewerClose" className="viewer-button viewer-close" type="button" autoFocus aria-label={t('viewer.close')} title={t('viewer.close')} onClick={onClose}>×</button>
    </div>
    <div className="image-viewer-toolbar">
      <div className="viewer-zoom-controls">
        <button id="viewerZoomOut" className="viewer-button viewer-zoom-button" type="button" disabled={!ready || scale <= minimumScale + 0.0001} aria-label={t('viewer.zoomOut')} title={t('viewer.zoomOut')} onClick={() => changeScale(scale / 1.25)}>−</button>
        <output id="viewerScale" className="viewer-scale" aria-live="polite">{ready ? `${Math.round(scale * 100)}%` : '—'}</output>
        <button id="viewerZoomIn" className="viewer-button viewer-zoom-button" type="button" disabled={!ready || scale >= maximumScale} aria-label={t('viewer.zoomIn')} title={t('viewer.zoomIn')} onClick={() => changeScale(scale * 1.25)}>+</button>
      </div>
      <div className="viewer-size-controls">
        <button id="viewerFit" className="viewer-button" type="button" disabled={!ready} onClick={fit}>{t('viewer.fit')}</button>
        <button id="viewerActualSize" className="viewer-button" type="button" disabled={!ready} onClick={() => changeScale(1)}>{t('viewer.actualSize')}</button>
      </div>
    </div>
    <div ref={viewportRef} id="viewerViewport" className={`image-viewer-viewport${canPan ? ' can-pan' : ''}${dragging ? ' is-dragging' : ''}`} role="region" aria-label={t('viewer.title', { label })} aria-describedby="viewerHint" tabIndex={0} data-scale={ready ? scale : ''} data-offset-x={offset.x} data-offset-y={offset.y} data-can-pan={canPan} onDoubleClick={event => {
      if (!ready || event.target.closest('button')) return;
      if (Math.abs(scale - fitScale) < 0.0001) changeScale(Math.max(1, fitScale * 2));
      else fit();
    }} onPointerDown={event => {
      if (!canPan || event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset };
      setDragging(true);
    }} onPointerMove={event => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      setOffset(constrainOffset({ x: drag.offset.x + event.clientX - drag.x, y: drag.offset.y + event.clientY - drag.y }, imageSize, viewport, scale));
    }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}>
      <img key={attempt} id="viewerImage" className="image-viewer-image" src={item.image_url} alt={label} draggable={false} hidden={status !== 'loaded'} style={{ width: imageSize.width * scale, height: imageSize.height * scale, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }} onLoad={event => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (!naturalWidth || !naturalHeight) { setStatus('error'); return; }
        setImageSize({ width: naturalWidth, height: naturalHeight }); setStatus('loaded');
      }} onError={() => setStatus('error')} />
      {status === 'loading' && <div className="viewer-status" role="status">{t('viewer.loading')}</div>}
      {status === 'error' && <div className="viewer-status" role="alert"><p>{t('viewer.error')}</p><button className="viewer-button" type="button" onClick={retry}>{t('viewer.retry')}</button></div>}
    </div>
    <p className="image-viewer-hint" id="viewerHint">{t('viewer.hint')}</p>
  </dialog>;
}
