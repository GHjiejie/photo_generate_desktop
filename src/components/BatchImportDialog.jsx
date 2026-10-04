import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';

const statuses = new Set(['import', 'imported', 'skip', 'skipped', 'conflict', 'invalid', 'unmatched', 'importable', 'error', 'pending', 'completed', 'rolled-back', 'unchanged']);
const display = (value, fallback = '—') => typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : '—';
function unwrap(result) {
  if (result?.ok) return result.data;
  const error = new Error(result?.error?.message || '');
  error.code = result?.error?.code || 'UNAVAILABLE';
  throw error;
}

export default function BatchImportDialog({ open, root, allowed, onClose, onImported }) {
  const { t, errorText, issueText } = useI18n();
  const bridge = window.portraitStudio;
  const supported = ['chooseBatchImages', 'chooseBatchManifest', 'previewBatch', 'commitBatch', 'cancelBatch'].every(name => typeof bridge?.[name] === 'function');
  const dialogRef = useRef(null);
  const busyRef = useRef(false);
  const current = useRef({ images: null, manifest: null, preview: null });
  const cleanup = useRef({ previewId: new Set(), imageSelectionId: new Set(), manifestSelectionId: new Set() });
  const [images, setImages] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [preview, setPreview] = useState(null);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState(null);
  const [lastReport, setLastReport] = useState(null);
  useLayoutEffect(() => {
    if (!open) return;
    setImages(null); setManifest(null); setPreview(null); setError(null);
    current.current = { images: null, manifest: null, preview: null };
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  async function release(payload) {
    if (!Object.keys(payload).length) return;
    unwrap(await bridge.cancelBatch(payload));
    for (const [key, value] of Object.entries(payload)) cleanup.current[key].delete(value);
  }
  async function releaseAll() {
    while (Object.values(cleanup.current).some(values => values.size)) {
      const payload = Object.fromEntries(Object.entries(cleanup.current).filter(([, values]) => values.size).map(([key, values]) => [key, values.values().next().value]));
      await release(payload);
    }
  }
  async function clearPreview() {
    if (!current.current.preview) return;
    await release({ previewId: current.current.preview.previewId });
    current.current.preview = null;
    setPreview(null);
  }
  async function exclusive(kind, action) {
    if (busyRef.current) return;
    busyRef.current = true; setOperation(kind); setError(null);
    try { await action(); }
    catch (actionError) { setError(actionError); }
    finally { busyRef.current = false; setOperation(''); }
  }
  async function choose(kind) {
    if (!supported || !allowed) return;
    await exclusive(kind, async () => {
      const value = unwrap(await (kind === 'images' ? bridge.chooseBatchImages() : bridge.chooseBatchManifest()));
      if (value.cancelled) return;
      if (typeof value.selectionId !== 'string' || !value.selectionId) throw { key: 'batch.invalidSelection' };
      const key = kind === 'images' ? 'imageSelectionId' : 'manifestSelectionId';
      cleanup.current[key].add(value.selectionId);
      await clearPreview();
      const previous = current.current[kind];
      if (previous && previous.selectionId !== value.selectionId) await release({ [key]: previous.selectionId });
      current.current[kind] = value;
      if (kind === 'images') setImages(value); else setManifest(value);
    });
  }
  async function previewSelection() {
    if (!supported || !allowed || !current.current.images || !current.current.manifest) return;
    await exclusive('preview', async () => {
      await clearPreview();
      const value = unwrap(await bridge.previewBatch({ imageSelectionId: current.current.images.selectionId, manifestSelectionId: current.current.manifest.selectionId, type: 'photo' }));
      if (typeof value.previewId === 'string' && value.previewId) cleanup.current.previewId.add(value.previewId);
      if (typeof value.previewId !== 'string' || !value.previewId || !Number.isSafeInteger(value.revision) || !Array.isArray(value.items) || !Array.isArray(value.issues) || !Array.isArray(value.unpaired)) throw { key: 'batch.invalidPreview' };
      current.current.preview = value;
      setPreview(value);
    });
  }
  async function close() {
    if (busyRef.current) return;
    await exclusive('cancel', async () => {
      if (supported) await releaseAll();
      current.current = { images: null, manifest: null, preview: null };
      setImages(null); setManifest(null); setPreview(null);
      onClose();
    });
  }
  async function commit() {
    const selected = current.current.preview;
    if (!allowed || !supported || selected?.canImport !== true || !(selected.importable > 0)) return;
    await exclusive('import', async () => {
      let value;
      try { value = unwrap(await bridge.commitBatch({ previewId: selected.previewId, confirmed: true, expectedVersion: selected.revision })); }
      catch (commitError) {
        if (commitError.code === 'CONFLICT') {
          await clearPreview();
          throw { key: 'batch.conflictError', cause: commitError };
        }
        throw commitError;
      }
      if (!value?.snapshot || !value?.report) throw { key: 'batch.missingReport' };
      setLastReport({ ...value.report, root: value.snapshot.root });
      onImported(value.snapshot, value.report);
      current.current.preview = null; setPreview(null);
      try { await releaseAll(); }
      catch (cleanupError) { setError({ key: 'batch.cleanupError', cause: cleanupError }); }
      current.current.images = null; current.current.manifest = null;
      setImages(null); setManifest(null);
    });
  }
  const canPreview = supported && allowed && images && manifest && !operation;
  const canImport = supported && allowed && preview?.canImport === true && preview.importable > 0 && !operation;
  const desktopTitle = !supported || !allowed ? t('common.desktopOnly') : undefined;
  const statusText = (status, report) => t(report && ['import', 'importable'].includes(status) ? 'batch.status.imported' : statuses.has(status) ? `batch.status.${status}` : 'batch.status.review');
  function explanation(item, index, issues = [], report = false) {
    const codes = [...new Set([item.code, item.reasonCode, ...(Array.isArray(item.issueCodes) ? item.issueCodes : [])].filter(code => typeof code === 'string' && code !== 'SELECTED_DEFAULT_TYPE'))];
    if (codes.length) return codes.map(code => issueText({ ...item, code })).join(' · ');
    const associated = issues.filter(issue => issue.code !== 'SELECTED_DEFAULT_TYPE' && (issue.recordIndex === index || item.id !== undefined && issue.id === item.id));
    if (associated.length) return associated.map(issue => issueText(issue)).join(' · ');
    if (typeof item.reason === 'string' && /^[A-Z][A-Z_]+$/.test(item.reason)) return issueText({ code: item.reason });
    return t(report && ['import', 'importable', 'imported'].includes(item.status) ? 'batch.reason.imported' : ['import', 'skip', 'conflict', 'invalid', 'unmatched'].includes(item.status) ? `batch.reason.${item.status}` : 'batch.reason.review');
  }
  function rowsTable(rows, issues, id, report = false) {
    return <div className="batch-table-wrap"><table id={id} className="batch-table"><thead><tr><th>{t('batch.column.name')}</th><th>{t('batch.column.image')}</th><th>{t('batch.column.status')}</th><th>{t('batch.column.reason')}</th></tr></thead><tbody>{rows.map((item, index) => <tr key={`${display(item.id, 'item')}-${index}`} data-status={item.status}><td><strong>{display(item.id)}</strong><div>{display(item.label)}</div></td><td>{display(item.sourceFileName, t('batch.imageMissing'))}{item.targetFileName && <small>{t('batch.savedAs', { name: display(item.targetFileName) })}</small>}</td><td><span className={`batch-item-status status-${statuses.has(item.status) ? item.status : 'review'}`}>{statusText(item.status, report)}</span></td><td>{explanation(item, index, issues, report)}{item.sourceMetadata && <details><summary>{t('batch.rawSource')}</summary><pre>{JSON.stringify(item.sourceMetadata, null, 2)}</pre></details>}</td></tr>)}</tbody></table></div>;
  }
  const visibleIssues = preview?.issues.filter(issue => issue.code !== 'SELECTED_DEFAULT_TYPE') ?? [];
  const reportRows = Array.isArray(lastReport?.mapping) ? lastReport.mapping : Array.isArray(lastReport?.report?.records) ? lastReport.report.records : [];
  const displayedError = error?.key ? t(error.key, { ...error.params, ...(error.cause ? { reason: errorText(error.cause) } : {}) }) : errorText(error);
  return <dialog ref={dialogRef} id="batchImportDialog" className="management-dialog batch-dialog" aria-labelledby="batchTitle" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="management-heading"><div><div className="detail-kicker">{t('common.localPortraits')}</div><h2 id="batchTitle">{t('batch.title')}</h2><p>{t('batch.hint')}</p></div><button id="batchClose" className="dialog-close" type="button" aria-label={t('batch.close')} disabled={Boolean(operation)} onClick={close}>×</button></div>
    <div className="batch-destination"><span>{t('batch.destination')}</span><div id="batchTargetRoot" title={preview?.root ?? root}>{preview?.root ?? root}</div></div>
    {!supported && <div className="form-error" role="alert">{t('batch.unsupported')}</div>}
    <div className="batch-sources"><div className="batch-source"><strong>{t('batch.imagesTitle')}</strong><p>{t('batch.imagesHint')}</p><button id="batchChooseImages" className="secondary-button" type="button" title={desktopTitle} disabled={!supported || !allowed || Boolean(operation)} onClick={() => choose('images')}>{t('batch.chooseImages')}</button><div id="batchImagesPath" className="batch-source-path" title={images?.path}>{images?.path ?? t('batch.unselected')}</div></div><div className="batch-source"><strong>{t('batch.manifestTitle')}</strong><p>{t('batch.manifestHint')}</p><button id="batchChooseManifest" className="secondary-button" type="button" title={desktopTitle} disabled={!supported || !allowed || Boolean(operation)} onClick={() => choose('manifest')}>{t('batch.chooseManifest')}</button><div id="batchManifestPath" className="batch-source-path" title={manifest?.path}>{manifest?.path ?? t('batch.unselected')}</div></div></div>
    <div className="batch-preview-controls"><button id="batchPreview" className="secondary-button" type="button" title={desktopTitle} disabled={!canPreview} onClick={previewSelection}>{t('batch.preview')}</button></div>
    {operation && <div className="batch-operation" role="status" aria-live="polite">{t(`batch.operation.${operation}`)}</div>}
    {error && <div id="batchError" className="form-error" role="alert">{displayedError}</div>}
    {preview && <div className="batch-preview"><div id="batchSummary" className="batch-summary" role="status"><span>{t('batch.total')} <strong>{count(preview.total)}</strong></span><span>{t('batch.matched')} <strong>{count(preview.matched)}</strong></span><span>{t('batch.importable')} <strong>{count(preview.importable)}</strong></span><span>{t('batch.skipped')} <strong>{count(preview.skipped)}</strong></span><span>{t('batch.conflicts')} <strong>{count(preview.conflicts)}</strong></span><span>{t('batch.unpairedCount')} <strong>{preview.unpaired.length}</strong></span></div>{rowsTable(preview.items, preview.issues, 'batchItems')}{visibleIssues.length > 0 && <div id="batchIssues" className="batch-issues"><h3>{t('batch.issuesTitle')}</h3><ul>{visibleIssues.map((issue, index) => <li key={index}>{issue.id !== undefined ? `${display(issue.id)} · ` : ''}{issueText(issue)}</li>)}</ul></div>}{preview.unpaired.length > 0 && <div id="batchUnpaired" className="batch-issues"><h3>{t('batch.unpairedTitle')}</h3><ul>{preview.unpaired.map((item, index) => <li key={index}>{display(item.sourceFileName)} · {issueText({ ...item, code: item.reasonCode ?? item.reason ?? 'NO_UNIQUE_MANIFEST_RECORD' })}</li>)}</ul></div>}<p className="batch-confirm-note">{preview.importable > 0 && preview.canImport ? t('batch.confirmHint', { count: preview.importable }) : t('batch.nothingImportable')}</p></div>}
    {lastReport && <div id="batchReport" className="batch-report" role="status"><h3>{t('batch.reportTitle')}</h3><p>{t('batch.reportSummary', { imported: count(lastReport.imported), skipped: count(lastReport.skipped), conflicts: count(lastReport.conflicts) })}{Number.isSafeInteger(lastReport.failed) ? ` · ${t('batch.reportFailed', { count: lastReport.failed })}` : ''}{Number.isSafeInteger(lastReport.invalid) ? ` · ${t('batch.reportInvalid', { count: lastReport.invalid })}` : ''}</p>{lastReport.archiveRel && <div className="field-note">{t('batch.reportSaved', { path: display(lastReport.archiveRel) })}</div>}<details><summary>{t('batch.reportDetails')}</summary>{rowsTable(reportRows, [], 'batchReportItems', true)}</details></div>}
    <div className="management-actions"><button id="batchCancel" className="secondary-button" type="button" disabled={Boolean(operation)} onClick={close}>{t(lastReport && !preview && !images && !manifest ? 'common.close' : 'common.cancel')}</button><button id="batchConfirm" className="primary-button" type="button" title={desktopTitle} disabled={!canImport} onClick={commit}>{t('batch.confirm')}{preview?.importable > 0 ? ` (${preview.importable})` : ''}</button></div>
  </dialog>;
}
