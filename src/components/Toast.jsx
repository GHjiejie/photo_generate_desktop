export default function Toast({ message }) {
  return <div className={`toast${message ? ' show' : ''}`} id="toast" role="status" aria-live="polite"><span className="toast-check">✓</span><span id="toastMessage">{message || '提示词已复制'}</span></div>;
}
