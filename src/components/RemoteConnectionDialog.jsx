import { createContext, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';

export const RemoteConnectionContext = createContext(null);
export const recommendedEndpoint = 'https://dashboard-18-180-65-241.sslip.io/portrait-studio/';
const errorStatuses = {
  REMOTE_NOT_CONFIGURED: 'unconfigured', INVALID_REMOTE_CONFIG: 'invalid-config', INVALID_REMOTE_ENDPOINT: 'invalid-address',
  REMOTE_ENVIRONMENT_OVERRIDE: 'environment', REMOTE_AUTH_REQUIRED: 'auth-required', REMOTE_FORBIDDEN: 'forbidden',
  REMOTE_ROUTE_MISSING: 'route-missing', REMOTE_SERVICE_UNAVAILABLE: 'service-unavailable',
  REMOTE_TIMEOUT: 'timeout', REMOTE_UNAVAILABLE: 'unreachable', REMOTE_INVALID_RESPONSE: 'invalid-response',
  AUTH_REQUIRED: 'auth-required', SESSION_EXPIRED: 'session-expired', AUTH_NOT_INITIALIZED: 'not-initialized',
  INVALID_CREDENTIALS: 'invalid-credentials', AUTH_RATE_LIMITED: 'login-rate-limited',
  REMOTE_GATEWAY_AUTH_REQUIRED: 'gateway-auth-required', PLATFORM_AUTH_UNAVAILABLE: 'platform-unavailable'
};
export const isConnectionError = error => Object.hasOwn(errorStatuses, error?.code);
export const connectionStatusForError = error => errorStatuses[error?.code] ?? 'failed';
export const isAuthenticationError = error => ['AUTH_REQUIRED', 'REMOTE_AUTH_REQUIRED', 'SESSION_EXPIRED', 'AUTH_NOT_INITIALIZED', 'INVALID_CREDENTIALS', 'AUTH_RATE_LIMITED', 'REMOTE_GATEWAY_AUTH_REQUIRED', 'PLATFORM_AUTH_UNAVAILABLE'].includes(error?.code);
export const platformSessionActive = authentication => authentication?.kind === 'platform' && authentication.username === 'admin' && Number.isFinite(Date.parse(authentication.expiresAt)) && Date.parse(authentication.expiresAt) > Date.now();

function validHTTPS(value) {
  try {
    const url = new URL(value);
    return value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '/' || url.pathname.endsWith('/'));
  } catch { return false; }
}

export default function RemoteConnectionDialog({ open, connection, allowed, pending, onClose, onConnect, onSignIn, onSignOut }) {
  const { t, uiLanguage } = useI18n();
  const dialogRef = useRef(null);
  const [endpoint, setEndpoint] = useState('');
  const [validation, setValidation] = useState('');
  useEffect(() => {
    if (open) { setEndpoint(connection.endpoint || connection.recommendedEndpoint || recommendedEndpoint); setValidation(''); }
  }, [open]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  const busy = Boolean(pending);
  const invalidConfig = connection.status === 'invalid-config';
  const authentication = connection.authentication;
  const loggedIn = platformSessionActive(authentication);
  const unavailableLogin = connection.initialized === false || ['not-initialized', 'gateway-auth-required', 'platform-unavailable'].includes(connection.status);
  const savedEndpoint = endpoint.trim() === connection.endpoint && connection.configured;
  const canLogin = allowed && !busy && savedEndpoint && (connection.endpoint.startsWith('https:') || connection.developmentLoginAllowed === true) && !unavailableLogin;
  const status = pending === 'login' ? 'signing-in' : pending === 'logout' ? 'signing-out' : pending ? 'connecting' : connection.status;
  const expiresAt = loggedIn ? new Intl.DateTimeFormat(uiLanguage === 'zh' ? 'zh-CN' : 'en', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(authentication.expiresAt)) : '';
  function submit(event) {
    event.preventDefault();
    if (!allowed || busy || invalidConfig) return;
    const value = endpoint.trim();
    if (!savedEndpoint && !validHTTPS(value)) { setValidation(t('connection.invalidAddress')); return; }
    setValidation('');
    onConnect(value);
  }
  return <dialog ref={dialogRef} id="remoteConnectionDialog" className="management-dialog remote-connection-dialog" aria-labelledby="remoteConnectionTitle" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="management-heading"><div><div className="detail-kicker">{t('connection.kicker')}</div><h2 id="remoteConnectionTitle">{t('connection.title')}</h2><p>{t('connection.hint')}</p></div><button id="remoteConnectionClose" className="dialog-close" type="button" aria-label={t('common.close')} disabled={busy} onClick={onClose}>×</button></div>
    <form id="remoteConnectionForm" onSubmit={submit}>
      <label className="remote-endpoint-field" htmlFor="remoteEndpoint"><span>{t('connection.address')}</span><input id="remoteEndpoint" type="url" value={endpoint} maxLength={2048} autoComplete="off" spellCheck={false} required readOnly={connection.environmentOverride} disabled={!allowed || busy || invalidConfig} onChange={event => { setEndpoint(event.target.value); setValidation(''); }} /><small>{t('connection.addressHint')}</small></label>
      {connection.environmentOverride && <p className="field-note">{t('connection.environmentHint')}</p>}
      {!allowed && <p className="field-note">{t('connection.desktopOnly')}</p>}
      <div id="remoteConnectionStatus" className={`remote-connection-status status-${status}`} role="status" aria-live="polite"><strong>{t('connection.statusLabel')}</strong><span>{t(`connection.status.${status}`)}</span></div>
      <div className="remote-platform-session"><div id="remotePlatformAccount"><span>{t('connection.platformAccount')}</span><strong>admin</strong></div><div id="remoteSessionStatus"><span>{t('connection.sessionLabel')}</span><strong>{t(loggedIn ? 'connection.session.active' : connection.status === 'session-expired' ? 'connection.session.expired' : 'connection.session.signedOut')}</strong></div>{loggedIn && <div id="remoteSessionExpires"><span>{t('connection.expiresAt')}</span><time dateTime={authentication.expiresAt} title={authentication.expiresAt}>{expiresAt}</time></div>}</div>
      {validation && <div id="remoteConnectionValidation" className="form-error" role="alert">{validation}</div>}
      <p className="remote-login-hint">{t('connection.loginHint')}</p>
      {connection.serverLoggedOut === false && !loggedIn && <p id="remoteLogoutStatus" className="field-note">{t('connection.signedOutUnconfirmed')}</p>}
      {!savedEndpoint && !invalidConfig && <p className="field-note">{t('connection.saveBeforeLogin')}</p>}
      <div className="management-actions">{loggedIn && <button id="remoteSignOut" className="secondary-button" type="button" disabled={!allowed || busy} onClick={onSignOut}>{t('connection.signOut')}</button>}<button id="remoteSignIn" className="secondary-button" type="button" disabled={!canLogin || invalidConfig} onClick={onSignIn}>{t('connection.signIn')}</button><button id="remoteSaveConnect" className="primary-button" type="submit" disabled={!allowed || busy || invalidConfig}>{t(pending === 'connect' ? 'connection.connecting' : savedEndpoint ? 'connection.reconnect' : 'connection.saveConnect')}</button></div>
    </form>
  </dialog>;
}
