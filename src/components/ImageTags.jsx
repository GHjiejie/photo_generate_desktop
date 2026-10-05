import { useState } from 'react';
import { tagKey, validateTags, MAX_TAGS, MAX_TAG_LENGTH } from '../tags.mjs';
import { useI18n } from '../i18n.jsx';

export default function ImageTags({ item, tags, catalog, disabled, onChange }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const currentKeys = new Set(tags.map(tagKey));
  function add(event) {
    event.preventDefault();
    if (disabled || !draft.trim()) return;
    const checked = validateTags([...tags, ...draft.split(/[,，;；\n]+/u)]);
    if (checked.error) { setError(checked.error); return; }
    onChange(item.id, checked.tags); setDraft(''); setError('');
  }
  return <form className="image-tags" onSubmit={add} onKeyDown={event => event.stopPropagation()} aria-label={t('tags.title')}>
    <div className="tags-heading"><span>{t('tags.title')}</span><span>{tags.length}/{MAX_TAGS}</span></div>
    {tags.length > 0 && <div className="tag-chips">{tags.map(name => <button key={tagKey(name)} className="tag-chip" type="button" disabled={disabled} title={name} aria-label={t('tags.removeNamed', { name })} onClick={() => { onChange(item.id, tags.filter(tag => tagKey(tag) !== tagKey(name))); setError(''); }}><span>{name}</span><span aria-hidden="true">×</span></button>)}</div>}
    <div className="tag-add-row"><input id="tagInput" type="text" value={draft} maxLength={512} disabled={disabled} autoComplete="off" list="tagSuggestions" placeholder={t('tags.placeholder')} aria-label={t('tags.addLabel')} aria-invalid={Boolean(error)} aria-describedby={error ? 'tagError' : 'tagInputHint'} onChange={event => { setDraft(event.target.value); setError(''); }} /><button id="addTag" type="submit" disabled={disabled || !draft.trim()}>{t('tags.add')}</button></div>
    <datalist id="tagSuggestions">{catalog.filter(tag => !currentKeys.has(tag.key)).map(tag => <option key={tag.key} value={tag.name} />)}</datalist>
    <span id="tagInputHint" className="sr-only">{t('tags.inputHint', { max: MAX_TAG_LENGTH })}</span>
    {error && <p id="tagError" className="tag-error" role="alert">{t(error, { max: MAX_TAG_LENGTH, count: MAX_TAGS })}</p>}
  </form>;
}

export function TagFilter({ catalog, value, onChange, disabled }) {
  const { t } = useI18n();
  if (!catalog.length && !value) return null;
  return <div className="tag-filter-bar">
    <label htmlFor="tagFilter">{t('tags.filter')}</label>
    <select id="tagFilter" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{t('tags.all')}</option>
      {value && !catalog.some(tag => tag.key === value) && <option value={value}>{value} (0)</option>}
      {catalog.map(tag => <option key={tag.key} value={tag.key}>{tag.name} ({tag.count})</option>)}
    </select>
    {value && <button id="clearTagFilter" className="text-button" type="button" disabled={disabled} onClick={() => onChange('')}>{t('tags.clearFilter')}</button>}
  </div>;
}
