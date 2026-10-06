import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { compareDrafts, MAX_PLANS, MAX_PLAN_TITLE_LENGTH } from '../prompt-plans.mjs';
import { MAX_DRAFT_LENGTH } from '../creative-lab.mjs';
import './prompt-plans.css';

export function PromptPlansIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="6" y="3" width="15" height="16" rx="2" /><path d="M3 7v12a2 2 0 0 0 2 2h12M10 7h7m-7 4h7m-7 4h4" /></svg>;
}

export default function PromptPlans({ plans, drafts, language, pending, storageFailed, onSave, onRename, onRemove, onRestore, onBack, onCopy }) {
  const { t, uiLanguage } = useI18n();
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(() => plans[0]?.id ?? '');
  const [renameTitle, setRenameTitle] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [copying, setCopying] = useState(false);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const titleRef = useRef(null);
  const searchRef = useRef(null);
  const deleteRef = useRef(null);
  const deleteCancelRef = useRef(null);
  const queryText = query.trim().toLocaleLowerCase();
  const filteredPlans = useMemo(() => plans.filter(plan => !queryText || [plan.title, plan.drafts.zh, plan.drafts.en].some(text => text.toLocaleLowerCase().includes(queryText))), [plans, queryText]);
  const selected = plans.find(plan => plan.id === selectedId);
  const savedPrompt = selected?.drafts?.[language] ?? '';
  const currentPrompt = drafts?.[language] ?? '';
  const diff = useMemo(() => comparing && selected ? compareDrafts(savedPrompt, currentPrompt) : null, [comparing, selected, savedPrompt, currentPrompt]);
  const hasDraft = Boolean(drafts?.zh?.trim() || drafts?.en?.trim());
  const selectedVisible = Boolean(selected && filteredPlans.some(plan => plan.id === selected.id));
  const promptLanguage = t(language === 'zh' ? 'app.chinese' : 'app.english');
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(uiLanguage === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), [uiLanguage]);
  const formattedDate = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? dateFormat.format(date) : ''; };

  useEffect(() => {
    mountedRef.current = true;
    titleRef.current?.focus();
    return () => { mountedRef.current = false; requestRef.current += 1; };
  }, []);
  useEffect(() => {
    if (!plans.some(plan => plan.id === selectedId) || (filteredPlans.length && !filteredPlans.some(plan => plan.id === selectedId))) {
      setSelectedId(filteredPlans[0]?.id ?? '');
      setComparing(false);
      setDeleting(false);
    }
  }, [plans, selectedId, filteredPlans]);
  useEffect(() => {
    setRenameTitle(selected?.title ?? '');
    setDeleting(false);
  }, [selected?.id, selected?.title]);
  useEffect(() => {
    requestRef.current += 1;
    setCopying(false);
    setFeedback(previous => previous?.key === 'plans.copied' || previous?.key === 'plans.copyFailed' ? null : previous);
  }, [selectedId, language, savedPrompt]);
  useEffect(() => { setFeedback(null); }, [language]);
  useEffect(() => { if (deleting) deleteCancelRef.current?.focus(); }, [deleting]);

  function showResult(result, success) {
    if (result?.ok !== true) { setFeedback({ type: 'error', key: result?.error || 'plans.unavailable' }); return false; }
    setFeedback({ type: 'success', key: success });
    return true;
  }
  function perform(action, success) {
    if (pending) return null;
    requestRef.current += 1;
    setCopying(false);
    try {
      const result = action();
      return showResult(result, success) ? result : null;
    } catch {
      setFeedback({ type: 'error', key: 'plans.unavailable' });
      return null;
    }
  }
  function save(event) {
    event.preventDefault();
    if (!hasDraft || pending) return;
    const result = perform(() => onSave(title), 'plans.saved');
    if (result) {
      setTitle('');
      setQuery('');
      if (result.plan?.id) setSelectedId(result.plan.id);
    }
  }
  function selectPlan(id) {
    requestRef.current += 1;
    setCopying(false);
    setFeedback(null);
    setDeleting(false);
    setComparing(false);
    setSelectedId(id);
  }
  function remove() {
    if (!selected || pending) return;
    const result = perform(() => onRemove(selected.id), 'plans.removed');
    if (result) {
      setDeleting(false);
      setComparing(false);
      setSelectedId(filteredPlans.find(plan => plan.id !== selected.id)?.id ?? '');
      searchRef.current?.focus();
    }
  }
  async function copy() {
    if (!selected || pending || copying || !savedPrompt.trim()) return;
    const request = ++requestRef.current;
    setCopying(true);
    setFeedback(null);
    try {
      const success = await onCopy(savedPrompt);
      if (!mountedRef.current || request !== requestRef.current) return;
      setFeedback({ type: success ? 'success' : 'error', key: success ? 'plans.copied' : 'plans.copyFailed' });
    } catch {
      if (mountedRef.current && request === requestRef.current) setFeedback({ type: 'error', key: 'plans.copyFailed' });
    } finally {
      if (mountedRef.current && request === requestRef.current) setCopying(false);
    }
  }

  return <section id="promptPlans" className="prompt-plans" data-selected-plan={selected?.id ?? ''} aria-labelledby="plansTitle">
    <div className="plans-heading"><div><h3 id="plansTitle"><PromptPlansIcon />{t('plans.title')}</h3><p>{t('plans.intro')}</p></div><button id="plansBack" className="secondary-button" type="button" disabled={pending} onClick={onBack}>{t('plans.back')}</button></div>
    <form className="plans-save" onSubmit={save}>
      <label className="sr-only" htmlFor="planTitle">{t('plans.name')}</label>
      <input id="planTitle" ref={titleRef} value={title} disabled={pending} placeholder={t('plans.namePlaceholder')} onChange={event => { setTitle(event.target.value); setFeedback(null); }} />
      <button id="planSave" className="primary-button" type="submit" disabled={pending || !hasDraft || !title.trim()}>{t('plans.save')}</button>
    </form>
    {!hasDraft && <p className="plans-draft-hint">{t('plans.noCurrentDraft')}</p>}
    {storageFailed && <p id="plansStorageWarning" className="plans-storage-warning" role="alert">{t('plans.sessionOnly')}</p>}
    {feedback && <p id="planFeedback" className={`plans-feedback ${feedback.type}`} data-feedback-key={feedback.key} role={feedback.type === 'error' ? 'alert' : 'status'}>{t(feedback.key, { maxTitle: MAX_PLAN_TITLE_LENGTH, maxDraft: MAX_DRAFT_LENGTH, maxPlans: MAX_PLANS })}</p>}
    <div className="plans-search"><label className="sr-only" htmlFor="planSearch">{t('plans.search')}</label><input id="planSearch" ref={searchRef} value={query} placeholder={t('plans.search')} onChange={event => { setQuery(event.target.value); setDeleting(false); }} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} /><span>{t('plans.count', { count: plans.length })}</span></div>
    <div className="plans-layout">
      <div className="plans-list" aria-label={t('plans.list')}>
        {filteredPlans.map(plan => <button key={plan.id} className={`plans-item${selectedId === plan.id ? ' selected' : ''}`} type="button" data-plan-id={plan.id} aria-pressed={selectedId === plan.id} disabled={pending} onClick={() => selectPlan(plan.id)}><strong title={plan.title}>{plan.title}</strong><span>{formattedDate(plan.updatedAt)}</span><small>{t(plan.drafts.zh.trim() && plan.drafts.en.trim() ? 'plans.bilingual' : plan.drafts.zh.trim() ? 'plans.chineseOnly' : 'plans.englishOnly')}</small></button>)}
        {!filteredPlans.length && <p className="plans-list-empty">{t(plans.length ? 'plans.noMatches' : 'plans.empty')}</p>}
      </div>
      {selectedVisible ? <article className="plans-detail" aria-labelledby="planSelectedTitle">
        <div className="plans-detail-heading"><h4 id="planSelectedTitle" title={selected.title}>{selected.title}</h4><span>{t('plans.updated', { date: formattedDate(selected.updatedAt) })}</span></div>
        <form className="plans-rename" onSubmit={event => { event.preventDefault(); if (renameTitle.trim() !== selected.title) perform(() => onRename(selected.id, renameTitle), 'plans.renamed'); }}><label className="sr-only" htmlFor="planRenameTitle">{t('plans.renameLabel')}</label><input id="planRenameTitle" value={renameTitle} disabled={pending} onChange={event => { setRenameTitle(event.target.value); setFeedback(null); }} /><button id="planRename" className="secondary-button" type="submit" disabled={pending || !renameTitle.trim() || renameTitle.trim() === selected.title}>{t('plans.rename')}</button></form>
        <div className="plans-prompt-heading"><span>{t('plans.promptLanguage', { language: promptLanguage })}</span><button id="planCompare" className="text-button" type="button" aria-pressed={comparing} disabled={pending} onClick={() => setComparing(value => !value)}>{t(comparing ? 'plans.showSaved' : 'plans.compare')}</button></div>
        {comparing && diff ? <>
          <div id="planDiffSummary" className="plans-diff-summary"><span>{t('plans.compareDirection')}</span><strong>{t('plans.diffSummary', { added: diff.added, removed: diff.removed })}</strong></div>
          <div id="planDiff" className="plans-prompt plans-diff" lang={language === 'zh' ? 'zh-CN' : 'en'} tabIndex="0" aria-label={t('plans.compareDirection')}>
            {!diff.added && !diff.removed && <p className="plans-diff-equal">{t('plans.noChanges')}</p>}
            {diff.lines.map((line, index) => <div key={index} className={`plans-diff-line ${line.type}`}><span className="plans-diff-symbol" aria-hidden="true">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span><span className="sr-only">{t(`plans.line.${line.type}`)}</span><span data-plan-diff={line.type}>{line.text}</span></div>)}
          </div>
        </> : <pre id="planPrompt" className={`plans-prompt${savedPrompt.trim() ? '' : ' empty'}`} lang={language === 'zh' ? 'zh-CN' : 'en'} tabIndex="0">{savedPrompt || t('plans.emptyLanguage', { language: promptLanguage })}</pre>}
        {deleting ? <div className="plans-delete-confirm" role="group" aria-label={t('plans.deleteConfirmTitle')}><p>{t('plans.deleteConfirm', { name: selected.title })}</p><div><button id="planDeleteCancel" ref={deleteCancelRef} className="secondary-button" type="button" disabled={pending} onClick={() => { setDeleting(false); window.requestAnimationFrame(() => deleteRef.current?.focus()); }}>{t('common.cancel')}</button><button id="planDeleteConfirm" className="plans-danger" type="button" disabled={pending} onClick={remove}>{t('plans.delete')}</button></div></div> : <footer className="plans-actions"><button id="planDelete" ref={deleteRef} className="plans-delete-link text-button" type="button" disabled={pending} onClick={() => { setDeleting(true); setFeedback(null); }}>{t('plans.delete')}</button><div><button id="planCopy" className="secondary-button" type="button" disabled={pending || copying || !savedPrompt.trim()} onClick={copy}>{t(copying ? 'plans.copying' : 'plans.copy')}</button><button id="planRestore" className="primary-button" type="button" disabled={pending} onClick={() => perform(() => onRestore(selected), 'plans.restored')}>{t('plans.restore')}</button></div></footer>}
      </article> : <div className="plans-detail-empty"><PromptPlansIcon /><strong>{t(plans.length ? 'plans.selectPlan' : 'plans.emptyTitle')}</strong><p>{t(plans.length ? 'plans.selectHint' : 'plans.emptyHint')}</p></div>}
    </div>
  </section>;
}
