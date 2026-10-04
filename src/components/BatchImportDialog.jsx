import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { RemoteConnectionContext } from './RemoteConnectionDialog.jsx';

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
  const remoteConnection = useContext(RemoteConnectionContext);
  const bridge = window.portraitStudio;
  const supported = ['chooseBatchDirectory', 'previewBatch', 'commitBatch', 'cancelBatch'].every(name => typeof bridge?.[name] === 'function');
  const dialogRef = useRef(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const active = useRef(open);
  active.current = open;
  const current = useRef({ directory: null, manifestCandidateId: '', preview: null });
  const cleanup = useRef({ previewId: new Set(), directorySelectionId: new Set() });
  const [directory, setDirectory] = useState(null);
  const [manifestCandidateId, setManifestCandidateId] = useState('');
  const [preview, setPreview] = useState(null);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState(null);
  const [lastReport, setLastReport] = useState(null);
  useLayoutEffect(() => {
    if (!open) return;
    setDirectory(null); setManifestCandidateId(''); setPreview(null); setError(null);
    current.current = { directory: null, manifestCandidateId: '', preview: null };
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (supported) releaseAll().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!open && supported && !busyRef.current) releaseAll().catch(() => {});
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
    if (mounted.current) setPreview(null);
  }
  async function exclusive(kind, action) {
    if (busyRef.current) return;
    busyRef.current = true; setOperation(kind); setError(null);
    try { await action(); }
    catch (actionError) { remoteConnection?.onAuthenticationError?.(actionError); if (mounted.current) setError(actionError); }
    finally {
      busyRef.current = false;
      if (mounted.current) setOperation('');
      if ((!mounted.current || !active.current) && supported) releaseAll().catch(() => {});
    }
  }
  async function chooseDirectory() {
    if (!supported || !allowed) return;
    await exclusive('directory', async () => {
      const value = unwrap(await bridge.chooseBatchDirectory());
      if (value.cancelled) return;
      if (typeof value.selectionId !== 'string' || !value.selectionId) throw { key: 'batch.invalidSelection' };
      cleanup.current.directorySelectionId.add(value.selectionId);
      if (!Array.isArray(value.manifests) || value.manifests.some(item => typeof item.candidateId !== 'string' || !item.candidateId || typeof item.relativePath !== 'string') || new Set(value.manifests.map(item => item.candidateId)).size !== value.manifests.length) {
        await release({ directorySelectionId: value.selectionId });
        throw { key: 'batch.invalidSelection' };
      }
      if (!mounted.current || !active.current) return;
      await clearPreview();
      const previous = current.current.directory;
      if (previous && previous.selectionId !== value.selectionId) await release({ directorySelectionId: previous.selectionId });
      const candidateId = value.manifests.length === 1 ? value.manifests[0].candidateId : '';
      current.current = { directory: value, manifestCandidateId: candidateId, preview: null };
      setDirectory(value); setManifestCandidateId(candidateId);
    });
  }
  async function chooseManifestCandidate(candidateId) {
    if (!supported || !allowed || candidateId === current.current.manifestCandidateId) return;
    if (candidateId && !current.current.directory?.manifests.some(item => item.candidateId === candidateId)) return;
    await exclusive('manifest', async () => {
      await clearPreview();
      current.current.manifestCandidateId = candidateId;
      setManifestCandidateId(candidateId);
    });
  }
  async function previewSelection() {
    if (!supported || !allowed || !current.current.directory || !current.current.manifestCandidateId) return;
    await exclusive('preview', async () => {
      await clearPreview();
      const value = unwrap(await bridge.previewBatch({ directorySelectionId: current.current.directory.selectionId, manifestCandidateId: current.current.manifestCandidateId, type: 'photo' }));
      if (typeof value.previewId === 'string' && value.previewId) cleanup.current.previewId.add(value.previewId);
      if (typeof value.previewId !== 'string' || !value.previewId || !Number.isSafeInteger(value.revision) || !Array.isArray(value.items) || !Array.isArray(value.issues) || !Array.isArray(value.unpaired)) throw { key: 'batch.invalidPreview' };
      if (!mounted.current || !active.current) return;
      current.current.preview = value;
      setPreview(value);
    });
  }
  async function close() {
    if (busyRef.current) return;
    await exclusive('cancel', async () => {
      if (supported) await releaseAll();
      current.current = { directory: null, manifestCandidateId: '', preview: null };
      setDirectory(null); setManifestCandidateId(''); setPreview(null);
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
      catch (cleanupError) { remoteConnection?.onAuthenticationError?.(cleanupError); setError({ key: 'batch.cleanupError', cause: cleanupError }); }
      current.current.directory = null; current.current.manifestCandidateId = '';
      setDirectory(null); setManifestCandidateId('');
    });
  }
  const manifest = directory?.manifests.find(item => item.candidateId === manifestCandidateId);
  const canPreview = supported && allowed && directory && manifest && !operation;
  const canImport = supported && allowed && preview?.canImport === true && preview.importable > 0 && !operation;
  const desktopTitle = !supported || !allowed ? t('common.desktopOnly') : undefined;
  const destination = bridge?.backend === 'remote' ? t('sidebar.serverLocation') : preview?.root ?? root;
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
    return <div className="batch-table-wrap"><table id={id} className="batch-table"><thead><tr><th>{t('batch.column.name')}</th><th>{t('batch.column.image')}</th><th>{t('batch.column.status')}</th><th>{t('batch.column.reason')}</th></tr></thead><tbody>{rows.map((item, index) => <tr key={`${display(item.id, 'item')}-${index}`} data-status={item.status}><td><strong>{display(item.id)}</strong><div>{display(item.label)}</div></td><td>{display(item.sourceRelativePath ?? item.sourceFileName, t('batch.imageMissing'))}{item.targetFileName && <small>{t('batch.savedAs', { name: display(item.targetFileName) })}</small>}</td><td><span className={`batch-item-status status-${statuses.has(item.status) ? item.status : 'review'}`}>{statusText(item.status, report)}</span></td><td>{explanation(item, index, issues, report)}{item.sourceMetadata && <details><summary>{t('batch.rawSource')}</summary><pre>{JSON.stringify(item.sourceMetadata, null, 2)}</pre></details>}</td></tr>)}</tbody></table></div>;
  }
  const visibleIssues = preview?.issues.filter(issue => issue.code !== 'SELECTED_DEFAULT_TYPE') ?? [];
  const reportRows = Array.isArray(lastReport?.mapping) ? lastReport.mapping : Array.isArray(lastReport?.report?.records) ? lastReport.report.records : [];
  const displayedError = error?.key ? t(error.key, { ...error.params, ...(error.cause ? { reason: errorText(error.cause) } : {}) }) : errorText(error);
  return <dialog ref={dialogRef} id="batchImportDialog" className="management-dialog batch-dialog" aria-labelledby="batchTitle" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="management-heading"><div><div className="detail-kicker">{t('common.localPortraits')}</div><h2 id="batchTitle">{t('batch.title')}</h2><p>{t('batch.hint')}</p></div><button id="batchClose" className="dialog-close" type="button" aria-label={t('batch.close')} disabled={Boolean(operation)} onClick={close}>×</button></div>
    <div className="batch-destination"><span>{t('batch.destination')}</span><div id="batchTargetRoot" title={destination}>{destination}</div></div>
    {!supported && <div className="form-error" role="alert">{t('batch.unsupported')}</div>}
    <div className="batch-sources"><div className="batch-source"><strong>{t('batch.directoryTitle')}</strong><p>{t('batch.directoryHint')}</p><button id="batchChooseDirectory" className="secondary-button" type="button" title={desktopTitle} disabled={!supported || !allowed || Boolean(operation)} onClick={chooseDirectory}>{t('batch.chooseDirectory')}</button><div id="batchDirectoryPath" className="batch-source-path" title={directory?.path}>{directory?.path ?? t('batch.unselected')}</div>{directory && <div id="batchDiscoverySummary" className="field-note" role="status">{t('batch.discoverySummary', { manifests: directory.manifests.length, images: count(directory.imageCount) })}</div>}</div><div className="batch-source"><strong>{t('batch.manifestTitle')}</strong><p>{t(directory?.manifests.length > 1 ? 'batch.multipleManifests' : 'batch.manifestHint')}</p><div id="batchManifestPath" className="batch-source-path" title={manifest?.relativePath}>{manifest?.relativePath ?? t(directory?.manifests.length === 0 ? 'batch.noManifest' : directory?.manifests.length > 1 ? 'batch.selectManifest' : 'batch.autoManifest')}</div>{manifest && <div className="field-note">{t('batch.manifestEntries', { count: count(manifest.recordCount) })}</div>}{directory?.imageCount === 0 && <div className="field-note">{t('batch.noImages')}</div>}</div></div>
    <div className="batch-preview-controls">{directory?.manifests.length > 1 && <label htmlFor="batchManifestCandidate">{t('batch.manifestChoice')}<select id="batchManifestCandidate" value={manifestCandidateId} disabled={Boolean(operation) || !allowed} onChange={event => chooseManifestCandidate(event.target.value)}><option value="">{t('batch.selectManifest')}</option>{directory.manifests.map(item => <option key={item.candidateId} value={item.candidateId}>{item.relativePath}</option>)}</select></label>}<button id="batchPreview" className="secondary-button" type="button" title={desktopTitle} disabled={!canPreview} onClick={previewSelection}>{t('batch.preview')}</button></div>
    {Array.isArray(directory?.ignoredManifests) && directory.ignoredManifests.length > 0 && <div id="batchDiscoveryIssues" className="batch-issues" role="status"><h3>{t('batch.ignoredManifestsTitle')}</h3><p className="field-note">{t('batch.ignoredManifestsHint')}</p><ul>{directory.ignoredManifests.map((item, index) => <li key={index}>{display(item.relativePath)} · {issueText(item)}</li>)}</ul></div>}
    {operation && <div className="batch-operation" role="status" aria-live="polite">{t(`batch.operation.${operation}`)}</div>}
    {error && <div id="batchError" className="form-error" role="alert">{displayedError}</div>}
    {preview && <div className="batch-preview"><div id="batchSummary" className="batch-summary" role="status"><span>{t('batch.total')} <strong>{count(preview.total)}</strong></span><span>{t('batch.matched')} <strong>{count(preview.matched)}</strong></span><span>{t('batch.importable')} <strong>{count(preview.importable)}</strong></span><span>{t('batch.skipped')} <strong>{count(preview.skipped)}</strong></span><span>{t('batch.conflicts')} <strong>{count(preview.conflicts)}</strong></span><span>{t('batch.unpairedCount')} <strong>{preview.unpaired.length}</strong></span></div>{rowsTable(preview.items, preview.issues, 'batchItems')}{visibleIssues.length > 0 && <div id="batchIssues" className="batch-issues"><h3>{t('batch.issuesTitle')}</h3><ul>{visibleIssues.map((issue, index) => <li key={index}>{issue.id !== undefined ? `${display(issue.id)} · ` : ''}{issueText(issue)}</li>)}</ul></div>}{preview.unpaired.length > 0 && <div id="batchUnpaired" className="batch-issues"><h3>{t('batch.unpairedTitle')}</h3><ul>{preview.unpaired.map((item, index) => <li key={index}>{display(item.sourceFileName)} · {issueText({ ...item, code: item.reasonCode ?? item.reason ?? 'NO_UNIQUE_MANIFEST_RECORD' })}</li>)}</ul></div>}<p className="batch-confirm-note">{preview.importable > 0 && preview.canImport ? t('batch.confirmHint', { count: preview.importable }) : t('batch.nothingImportable')}</p></div>}
    {lastReport && <div id="batchReport" className="batch-report" role="status"><h3>{t('batch.reportTitle')}</h3><p>{t('batch.reportSummary', { imported: count(lastReport.imported), skipped: count(lastReport.skipped), conflicts: count(lastReport.conflicts) })}{Number.isSafeInteger(lastReport.failed) ? ` · ${t('batch.reportFailed', { count: lastReport.failed })}` : ''}{Number.isSafeInteger(lastReport.invalid) ? ` · ${t('batch.reportInvalid', { count: lastReport.invalid })}` : ''}</p>{lastReport.archiveRel && <div className="field-note">{t('batch.reportSaved', { path: display(lastReport.archiveRel) })}</div>}<details><summary>{t('batch.reportDetails')}</summary>{rowsTable(reportRows, [], 'batchReportItems', true)}</details></div>}
    <div className="management-actions"><button id="batchCancel" className="secondary-button" type="button" disabled={Boolean(operation)} onClick={close}>{t(lastReport && !preview && !directory ? 'common.close' : 'common.cancel')}</button><button id="batchConfirm" className="primary-button" type="button" title={desktopTitle} disabled={!canImport} onClick={commit}>{t('batch.confirm')}{preview?.importable > 0 ? ` (${preview.importable})` : ''}</button></div>
  </dialog>;
}
