import { useI18n } from '../i18n.jsx';
export default function Toast({ message }) {
  const { t, errorText } = useI18n();
  return <div className={`toast${message ? ' show' : ''}`} id="toast" role="status" aria-live="polite"><span className="toast-check">✓</span><span id="toastMessage">{message ? typeof message === 'string' ? message : errorText(message) : t('common.copied')}</span></div>;
}
