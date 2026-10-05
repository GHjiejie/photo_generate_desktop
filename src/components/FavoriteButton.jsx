import { labelFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';

export function StarIcon({ filled = false }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.3-5.6-3-5.6 3 1-6.3-4.5-4.4 6.3-.9Z" /></svg>;
}

export function ShuffleIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3.5-2 5-5m2-2c1.5-3 3-5 5-5h3m-4-4 4 4-4 4" /></svg>;
}

export default function FavoriteButton({ item, favorite, disabled, onToggle, className = '' }) {
  const { t, uiLanguage } = useI18n();
  const label = t(favorite ? 'favorites.removeNamed' : 'favorites.addNamed', { name: labelFor(item, uiLanguage) });
  return <button className={`favorite-button${favorite ? ' favorited' : ''} ${className}`} type="button" data-favorite-id={item?.id} aria-label={label} title={label} aria-pressed={favorite} disabled={disabled} onClick={event => { event.stopPropagation(); onToggle(item.id); }}><StarIcon filled={favorite} /></button>;
}
