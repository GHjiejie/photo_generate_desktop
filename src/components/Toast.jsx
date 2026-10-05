import { useI18n } from '../i18n.jsx';
export default function Toast({ message, error = false }) {
  const { t, errorText } = useI18n();
  return <div className={`toast${message ? ' show' : ''}${error ? ' error' : ''}`} id="toast" role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}><span className="toast-check" aria-hidden="true">{error ? '!' : '✓'}</span><span id="toastMessage">{message ? typeof message === 'string' ? message : errorText(message) : t('common.copied')}</span></div>;
}
