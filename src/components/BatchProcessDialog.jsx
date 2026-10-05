import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { portraitNumber, labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';

const FORMATS = {
  original: { mime: null, extension: null },
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
};
const mimeExtension = mime => mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('DECODE_FAILED'));
    image.src = url;
  });
}

async function processItem(item, options) {
  const response = await fetch(item.image_url, { cache: 'no-store' });
  if (!response.ok) throw new Error('FETCH_FAILED');
  const blob = await response.blob();
  const sourceType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  const format = FORMATS[options.format] ?? FORMATS.original;
  const targetMime = format.mime ?? sourceType;
  const sourceExt = mimeExtension(sourceType);
  const needsResize = options.resizeEnabled && Number.isFinite(options.maxDimension) && options.maxDimension > 0;
  let outputBlob;
  if (!needsResize && !format.mime) {
    outputBlob = blob;
  } else {
    const image = await loadImage(URL.createObjectURL(blob));
    let { naturalWidth: width, naturalHeight: height } = image;
    if (needsResize) {
      const scale = Math.min(1, options.maxDimension / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(image.src);
    outputBlob = await new Promise(resolve => canvas.toBlob(resolve, targetMime, 0.92));
    if (!outputBlob) throw new Error('ENCODE_FAILED');
  }
  const extension = format.extension ?? sourceExt;
  const base = options.pattern.replaceAll('{id}', portraitNumber(item)).replaceAll('{label}', (labelFor(item, options.language) || `portrait-${portraitNumber(item)}`).replace(/[\\/:*?"<>|]/g, '_').trim() || `portrait-${portraitNumber(item)}`);
  return { fileName: `${base}.${extension}`, blob: outputBlob };
}

export default function BatchProcessDialog({ open, items, language, onClose }) {
  const { t } = useI18n();
  const dialogRef = useRef(null);
  const busyRef = useRef(false);
  const downloadRef = useRef(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [resizeEnabled, setResizeEnabled] = useState(true);
  const [maxDimension, setMaxDimension] = useState(2048);
  const [format, setFormat] = useState('original');
  const [pattern, setPattern] = useState('{id}-{label}');
  const [operation, setOperation] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState('');
  const [report, setReport] = useState(null);

  useLayoutEffect(() => {
    if (!open) return;
    setSelectedIds(new Set(items.map(item => item.id)));
    setReport(null); setError(''); setProgress({ done: 0, total: 0 });
  }, [open, items]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const selectedItems = useMemo(() => items.filter(item => selectedIds.has(item.id)), [items, selectedIds]);
  const canRun = selectedItems.length > 0 && !operation;

  function toggle(id) {
    if (operation) return;
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (operation) return;
    setSelectedIds(previous => previous.size === items.length ? new Set() : new Set(items.map(item => item.id)));
  }
  function close() {
    if (busyRef.current) return;
    setReport(null); setError('');
    onClose();
  }
  async function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = downloadRef.current ?? document.createElement('a');
    downloadRef.current = anchor;
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    await new Promise(resolve => setTimeout(resolve, 250));
    URL.revokeObjectURL(url);
  }
  async function run() {
    if (!canRun) return;
    busyRef.current = true; setOperation('process'); setError(''); setReport(null);
    const failures = [];
    const usedNames = new Set();
    setProgress({ done: 0, total: selectedItems.length });
    try {
      const options = { resizeEnabled, maxDimension: Number(maxDimension), format, pattern: pattern.trim() || '{id}', language };
      for (const item of selectedItems) {
        try {
          let { fileName, blob } = await processItem(item, options);
          while (usedNames.has(fileName)) fileName = fileName.replace(/(\.[^.]+)$/, match => `-${item.id}${match}`);
          usedNames.add(fileName);
          await saveBlob(blob, fileName);
        } catch {
          failures.push(item);
        }
        setProgress(previous => ({ ...previous, done: previous.done + 1 }));
      }
      setReport({ processed: selectedItems.length - failures.length, failed: failures.length, failures });
    } finally {
      busyRef.current = false; setOperation('');
    }
  }

  return <dialog ref={dialogRef} id="batchProcessDialog" className="management-dialog batch-dialog" aria-labelledby="batchProcessTitle" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="management-heading">
      <div>
        <div className="detail-kicker">{t('common.localPortraits')}</div>
        <h2 id="batchProcessTitle">{t('process.title')}</h2>
        <p>{t('process.hint')}</p>
      </div>
      <button className="dialog-close" type="button" aria-label={t('common.close')} disabled={Boolean(operation)} onClick={close}>×</button>
    </div>

    <div className="batch-summary" role="status">
      <span>{t('process.selected')} <strong>{selectedItems.length}</strong></span>
      <span>{t('process.total')} <strong>{items.length}</strong></span>
      <button className="secondary-button process-toggle-all" type="button" disabled={Boolean(operation)} onClick={toggleAll}>{t(selectedIds.size === items.length ? 'process.deselectAll' : 'process.selectAll')}</button>
    </div>

    <div className="process-grid" role="group" aria-label={t('process.selectionLabel')}>
      {items.map(item => {
        const name = labelFor(item, language) || portraitNumber(item);
        const checked = selectedIds.has(item.id);
        return <label key={item.id} className={`process-item${checked ? ' selected' : ''}`}>
          <input type="checkbox" checked={checked} disabled={Boolean(operation)} onChange={() => toggle(item.id)} />
          <img src={item.image_url} alt={name} loading="lazy" />
          <span>{portraitNumber(item)} {name}</span>
        </label>;
      })}
    </div>

    <div className="process-options">
      <fieldset className="process-fieldset">
        <legend>{t('process.resizeTitle')}</legend>
        <label className="process-check"><input type="checkbox" checked={resizeEnabled} disabled={Boolean(operation)} onChange={event => setResizeEnabled(event.target.checked)} />{t('process.resizeEnable')}</label>
        <label>{t('process.maxDimension')}<input type="number" min="64" max="12000" step="1" value={maxDimension} disabled={Boolean(operation) || !resizeEnabled} onChange={event => setMaxDimension(event.target.value)} /></label>
      </fieldset>
      <fieldset className="process-fieldset">
        <legend>{t('process.formatTitle')}</legend>
        <label>{t('process.format')}<select value={format} disabled={Boolean(operation)} onChange={event => setFormat(event.target.value)}>
          <option value="original">{t('process.formatOriginal')}</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
          <option value="webp">WebP</option>
        </select></label>
      </fieldset>
      <fieldset className="process-fieldset">
        <legend>{t('process.nameTitle')}</legend>
        <label>{t('process.pattern')}<input type="text" value={pattern} maxLength={80} disabled={Boolean(operation)} onChange={event => setPattern(event.target.value)} placeholder="{id}-{label}" /></label>
        <div className="field-note">{t('process.patternHint')}</div>
      </fieldset>
    </div>

    {operation && <div className="batch-operation" role="status" aria-live="polite">{t('process.operation', { done: progress.done, total: progress.total })}</div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {report && <div className="batch-summary process-report" role="status">
      <span>{t('process.reportProcessed')} <strong>{report.processed}</strong></span>
      <span>{t('process.reportFailed')} <strong>{report.failed}</strong></span>
      {report.failed > 0 && <span>{report.failures.map(item => portraitNumber(item)).join(', ')}</span>}
    </div>}

    <div className="management-actions">
      <button className="secondary-button" type="button" disabled={Boolean(operation)} onClick={close}>{t(report ? 'common.close' : 'common.cancel')}</button>
      <button id="batchProcessRun" className="primary-button" type="button" disabled={!canRun} onClick={run}>{t('process.run')}{selectedItems.length > 0 ? ` (${selectedItems.length})` : ''}</button>
    </div>
  </dialog>;
}
