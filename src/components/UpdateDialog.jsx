import { useCallback, useEffect, useRef, useState } from 'react';

const initialState = { currentVersion: '', status: 'idle', sourceRoot: '', sourceManifest: '', reasons: [], canCheck: false, canDownload: false, canInstall: false, verified: false };
const statusLabels = {
  idle: '尚未检查本地更新', unavailable: '更新暂不可用', checking: '正在检查本地版本信息…',
  'up-to-date': '此来源没有更高版本', available: '发现可用的新版本',
  downloading: '正在准备并校验更新…', downloaded: '更新已准备', installing: '正在安排重启并安装…', error: '更新暂未完成',
};
function unwrap(result) {
  if (result?.ok) return result.data;
  throw new Error(result?.error?.message || '无法取得更新状态，请重试。');
}
function normalise(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(statusLabels, value.status)) throw new Error('更新状态无效，请重新检查。');
  return {
    ...initialState, ...value,
    currentVersion: typeof value.currentVersion === 'string' ? value.currentVersion : '',
    sourceRoot: typeof value.sourceRoot === 'string' ? value.sourceRoot : '',
    sourceManifest: typeof value.sourceManifest === 'string' ? value.sourceManifest : '',
    availableVersion: typeof value.availableVersion === 'string' ? value.availableVersion : '',
    releaseNotes: typeof value.releaseNotes === 'string' ? value.releaseNotes : '',
    updateId: typeof value.updateId === 'string' ? value.updateId : '',
    reasons: Array.isArray(value.reasons) ? value.reasons.filter(reason => typeof reason?.message === 'string') : [],
    canCheck: value.canCheck === true, canDownload: value.canDownload === true,
    canInstall: value.canInstall === true, verified: value.verified === true,
  };
}

export default function UpdateDialog({ open, onClose, installationAllowed }) {
  const bridge = window.portraitStudio;
  const desktop = typeof bridge?.getUpdateState === 'function';
  const dialogRef = useRef(null);
  const actionRef = useRef(false);
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const acceptState = useCallback(value => {
    const next = normalise(value);
    setState(next);
    setConfirmation(previous => previous && previous.updateId === next.updateId && next.canInstall && next.verified && next.status === 'downloaded' ? previous : null);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    let receivedEvent = false;
    let unsubscribe;
    setError('');
    setConfirmation(null);
    if (!desktop) {
      setState({ ...initialState, status: 'unavailable', reasons: [{ code: 'DESKTOP_REQUIRED', message: '当前为网页预览。本地版本检查与升级请使用 Mac 桌面应用。' }] });
      return;
    }
    setLoading(true);
    if (typeof bridge.onUpdateState === 'function') {
      unsubscribe = bridge.onUpdateState(value => {
        if (!live) return;
        receivedEvent = true;
        try { acceptState(value?.ok === undefined ? value : unwrap(value)); }
        catch (eventError) { setError(eventError.message); }
      });
    }
    bridge.getUpdateState().then(unwrap).then(value => { if (live && !receivedEvent) acceptState(value); }).catch(readError => { if (live && !receivedEvent) setError(readError.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [open, desktop, bridge, acceptState]);
  const preparing = state.status === 'downloading';
  const busy = loading || Boolean(operation) || preparing || state.status === 'checking' || state.status === 'installing';
  const installReady = state.status === 'downloaded' && state.canInstall && state.verified && Boolean(state.updateId && state.availableVersion) && installationAllowed;
  function close() {
    if (operation === 'install' || operation === 'choose' || state.status === 'installing') return;
    setConfirmation(null);
    onClose();
  }
  async function perform(kind, method, payload) {
    if (actionRef.current || loading || !desktop || typeof bridge[method] !== 'function') return;
    actionRef.current = true;
    setOperation(kind);
    setError('');
    try {
      const value = unwrap(await bridge[method](...(payload === undefined ? [] : [payload])));
      if (!value.cancelled) acceptState(value);
    } catch (actionError) {
      setError(actionError.message);
      try { acceptState(unwrap(await bridge.getUpdateState())); } catch { /* Keep the last known state and the actual operation error. */ }
    } finally { actionRef.current = false; setOperation(''); }
  }
  function confirmInstall() {
    if (!confirmation || !installReady || confirmation.updateId !== state.updateId || busy) return;
    perform('install', 'installUpdate', { confirmed: true, updateId: confirmation.updateId });
  }
  const noSource = desktop && !state.sourceRoot;
  const canChoose = desktop && typeof bridge.chooseUpdateSource === 'function';
  return <dialog ref={dialogRef} id="updateDialog" className="management-dialog update-dialog" aria-labelledby="updateTitle" onCancel={event => { event.preventDefault(); if (confirmation && !busy) setConfirmation(null); else close(); }}>
    <div className="management-heading"><div><div className="detail-kicker">PORTRAIT STUDIO</div><h2 id="updateTitle">{confirmation ? '重启并安装更新？' : '检查更新 / 升级最新版'}</h2><p>当前版本 <span id="updateCurrentVersion">{state.currentVersion || (loading ? '读取中…' : '未取得版本信息')}</span></p></div><button id="updateClose" className="dialog-close" type="button" aria-label="关闭更新窗口" disabled={operation === 'install' || operation === 'choose' || state.status === 'installing'} onClick={close}>×</button></div>
    {confirmation ? <div className="update-confirmation"><div className="update-version">安装版本 <strong>{confirmation.version}</strong></div><p>Portrait Studio 将退出并重启。素材库和用户设置会保留；安装失败时恢复原应用，并保留恢复记录。系统安全检查拒绝时停止安装。</p><p className="field-note">本地更新包的校验值仅验证完整性，不能独立证明发布者身份。请核对来源和版本说明后继续。</p></div> : <>
      <div className="update-state-panel"><strong id="updateStatus" role="status" aria-live="polite">{loading ? '正在读取更新状态…' : noSource && state.status !== 'error' ? '请选择本地版本文档目录' : statusLabels[state.status]}{state.status === 'downloaded' && state.verified ? ' · 校验已通过' : ''}</strong>{noSource && <p>选择存放版本文档和更新包的本地目录，然后检查是否有更高版本。</p>}{state.sourceRoot && <div className="update-source"><span>更新来源</span><div id="updateSourceRoot" title={state.sourceRoot}>{state.sourceRoot}</div>{state.sourceManifest && <div className="field-note">版本文档：{state.sourceManifest}</div>}</div>}{state.availableVersion && <div className="update-version">候选版本 <strong id="updateAvailableVersion">{state.availableVersion}</strong></div>}</div>
      {preparing && <div id="updateProgress" className="update-progress" role="status" aria-live="polite"><progress aria-label="本地更新准备进度" /><span>正在处理本地更新包；完成后可确认重启安装。</span></div>}
      {state.releaseNotes && <div className="update-release"><h3>版本说明</h3><pre id="updateReleaseNotes">{state.releaseNotes}</pre></div>}
      {state.reasons.length > 0 && <div id="updateReasons" className="update-reasons">{state.reasons.map((reason, index) => <p key={`${reason.code || 'reason'}-${index}`}>{reason.message}</p>)}</div>}
      <p className="update-integrity-note">SHA-256 仅校验更新包完整性，不能独立证明发布者身份。准备更新不会自动安装；重启安装前需要再次确认。</p>
    </>}
    {error && <div id="updateError" className="form-error" role="alert">{error}</div>}
    <div className="management-actions update-actions">{confirmation ? <><button id="updateCancelInstall" className="secondary-button" type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button><button id="updateConfirmInstall" className="primary-button" type="button" disabled={busy || !installReady} onClick={confirmInstall}>{operation === 'install' ? '正在安排安装…' : '确认重启并安装'}</button></> : <><button id="updateChooseSource" className="secondary-button" type="button" disabled={!canChoose || busy} onClick={() => perform('choose', 'chooseUpdateSource')}>{state.sourceRoot ? '更换本地来源' : '选择本地版本目录'}</button><button id="updateCheck" className="secondary-button" type="button" disabled={!state.canCheck || busy} onClick={() => perform('check', 'checkForUpdates')}>检查更新</button>{state.canDownload && state.updateId && <button id="updatePrepare" className="primary-button" type="button" disabled={busy} onClick={() => perform('prepare', 'downloadUpdate', { confirmed: true, updateId: state.updateId })}>准备并校验更新</button>}{installReady && <button id="updateInstall" className="primary-button" type="button" disabled={busy} onClick={() => setConfirmation({ updateId: state.updateId, version: state.availableVersion })}>重启并安装</button>}</>}</div>
  </dialog>;
}
