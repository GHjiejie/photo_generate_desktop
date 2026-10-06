import { useEffect, useRef } from 'react';
import { labelFor, promptFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';
import { CreativeLabIcon } from './CreativeLab.jsx';

export function CompareIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="4" width="7" height="16" rx="1.5" /><rect x="14" y="4" width="7" height="16" rx="1.5" /></svg>;
}

export function CompareButton({ item, selected, disabled, onToggle, className = '' }) {
  const { t, uiLanguage } = useI18n();
  const label = t(selected ? 'compare.removeNamed' : 'compare.addNamed', { name: labelFor(item, uiLanguage) });
  return <button className={`image-action-button compare-button${selected ? ' active' : ''} ${className}`} type="button" data-compare-id={item.id} title={label} aria-label={label} aria-pressed={selected} disabled={disabled} onClick={event => { event.stopPropagation(); onToggle(item.id); }}><CompareIcon /></button>;
}

export function CompareTray({ items, disabled, onRemove, onClear, onOpen }) {
  const { t, uiLanguage } = useI18n();
  if (!items.length) return null;
  return <aside id="compareTray" className="compare-tray" aria-label={t('compare.selection')}>
    <div className="compare-summary"><strong>{t('compare.title')}</strong><span role="status">{t('compare.count', { count: items.length })}</span></div>
    <div className="compare-thumbnails">{items.map(item => <button key={item.id} className="compare-thumbnail" type="button" disabled={disabled} aria-label={t('compare.removeNamed', { name: labelFor(item, uiLanguage) })} title={t('compare.removeNamed', { name: labelFor(item, uiLanguage) })} onClick={() => onRemove(item.id)}><img src={item.image_url} alt={labelFor(item, uiLanguage)} /><span aria-hidden="true">×</span></button>)}</div>
    <button id="clearComparison" className="text-button" type="button" disabled={disabled} onClick={onClear}>{t('compare.clear')}</button>
    <button id="openComparison" className="primary-button" type="button" disabled={disabled || items.length < 2} title={items.length < 2 ? t('compare.pickMore') : t('compare.open')} onClick={onOpen}>{t('compare.open')}</button>
  </aside>;
}

export default function CompareDialog({ items, language, pending, onClose, onCopy, onOpenImage, onCreativeLab }) {
  const { t, uiLanguage } = useI18n();
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (items && !dialog.open) dialog.showModal();
    else if (!items && dialog.open) dialog.close();
  }, [items]);
  return <dialog id="compareDialog" ref={dialogRef} className="compare-dialog" aria-labelledby="compareTitle" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div className="compare-dialog-heading"><div><h2 id="compareTitle">{t('compare.title')}</h2><p>{t('compare.description')}</p></div><div className="compare-creative-actions"><button id="compareCreativeLab" className="secondary-button" type="button" disabled={pending} onClick={onCreativeLab}><CreativeLabIcon /><span>{t('lab.remixComparison')}</span></button><button id="closeComparison" className="dialog-close" type="button" disabled={pending} aria-label={t('common.close')} onClick={onClose}>×</button></div></div>
    <div className="compare-columns" data-count={items?.length ?? 0}>
      {(items ?? []).map(item => <section key={item.id} className="compare-column" data-id={item.id} aria-label={labelFor(item, uiLanguage)}>
        <div className="compare-image"><img src={item.image_url} alt={labelFor(item, uiLanguage)} /></div>
        <div className="compare-column-heading"><h3>{labelFor(item, uiLanguage)}</h3><button className="text-button" type="button" disabled={pending} onClick={() => onOpenImage(item)}>{t('detail.openImage')}</button></div>
        <div className="prompt-box"><pre lang={language === 'zh' ? 'zh-CN' : 'en'}>{promptFor(item, language)}</pre></div>
        <button className="compare-copy secondary-button" type="button" disabled={pending} onClick={() => onCopy(item)}>{t('detail.copy')}</button>
      </section>)}
    </div>
  </dialog>;
}
