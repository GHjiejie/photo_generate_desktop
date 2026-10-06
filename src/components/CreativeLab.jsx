import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';
import { labelFor, portraitNumber, promptFor } from '../portraits.js';
import { MAX_DRAFT_LENGTH, DICE_CATEGORIES, splitPromptBlocks, composeBlocks, rollDice, diceOption, diceText } from '../creative-lab.mjs';

export function CreativeLabIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 3h6m-5 0v6l-6.1 9.3A2 2 0 0 0 5.6 21h12.8a2 2 0 0 0 1.7-2.7L14 9V3M7.4 13h9.2" /><path d="m10 16 1.1 1.1M14 18h.01" /></svg>;
}

function LockIcon({ locked }) {
  return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" focusable="false"><rect x="4" y="8" width="12" height="9" rx="2" /><path d={locked ? 'M7 8V6a3 3 0 0 1 6 0v2' : 'M7 8V6a3 3 0 0 1 6 0'} /><path d="M10 12v2" /></svg>;
}

const emptyHistory = () => ({ zh: [], en: [] });
const categoryId = category => `labDice${category[0].toUpperCase()}${category.slice(1)}`;

export default function CreativeLab({ session, items, language, drafts, onDraftChange, onSourceIdsChange, pending, storageFailed, onClose, onCopy }) {
  const { t, uiLanguage } = useI18n();
  const dialogRef = useRef(null);
  const sessionIdRef = useRef(null);
  const copyRequestRef = useRef(0);
  const [sourceId, setSourceId] = useState('');
  const [selected, setSelected] = useState({ zh: [], en: [] });
  const [dice, setDice] = useState({});
  const [locked, setLocked] = useState({});
  const [history, setHistory] = useState(emptyHistory);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const sources = session?.sources ?? [];
  const currentDraft = drafts?.[language] ?? '';
  const sourceIds = sources.map(source => source.id);
  const availableItems = items.filter(item => !sourceIds.includes(item.id));
  const blocksByLanguage = useMemo(() => ({
    zh: sources.flatMap(source => splitPromptBlocks(promptFor(source, 'zh'), source.id, 'zh')),
    en: sources.flatMap(source => splitPromptBlocks(promptFor(source, 'en'), source.id, 'en'))
  }), [session]);
  const blocks = blocksByLanguage[language];
  const selectedKeys = new Set(selected[language]);
  const selectedBlocks = blocks.filter(block => selectedKeys.has(block.key));

  useEffect(() => {
    if (!session) return;
    if (sessionIdRef.current !== session.id) {
      sessionIdRef.current = session.id;
      const firstId = session.sources[0]?.id;
      setSelected({
        zh: blocksByLanguage.zh.filter(block => block.sourceId === firstId).map(block => block.key),
        en: blocksByLanguage.en.filter(block => block.sourceId === firstId).map(block => block.key)
      });
      setDice(rollDice({}, {})); setLocked({}); setHistory(emptyHistory()); setError(''); setSourceId(''); setCopied(false); copyRequestRef.current += 1;
    } else {
      setSelected(previous => ({
        zh: previous.zh.filter(key => blocksByLanguage.zh.some(block => block.key === key)),
        en: previous.en.filter(key => blocksByLanguage.en.some(block => block.key === key))
      }));
      setSourceId('');
    }
  }, [session, blocksByLanguage]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (session && !dialog.open) dialog.showModal();
    else if (!session && dialog.open) dialog.close();
  }, [session]);
  useEffect(() => { setError(''); setCopied(false); copyRequestRef.current += 1; }, [language]);

  function changeBlock(key, checked) {
    setSelected(previous => ({ ...previous, [language]: checked ? [...previous[language], key] : previous[language].filter(value => value !== key) }));
  }
  function writeDraft(text, remember = true) {
    if (pending) return false;
    setCopied(false); copyRequestRef.current += 1;
    if (text.length > MAX_DRAFT_LENGTH) { setError('lab.tooLong'); return false; }
    const result = onDraftChange(language, text);
    if (result?.error) { setError(result.error); return false; }
    if (remember && text !== currentDraft) setHistory(previous => ({ ...previous, [language]: [...previous[language], currentDraft].slice(-20) }));
    setError(''); return true;
  }
  function compose() {
    if (pending || !selectedBlocks.length) return;
    const result = composeBlocks(selectedBlocks);
    if (result.error) { setError(result.error); return; }
    writeDraft(result.text);
  }
  function undo() {
    const previous = history[language];
    if (!previous.length || pending) return;
    if (writeDraft(previous.at(-1), false)) setHistory(value => ({ ...value, [language]: value[language].slice(0, -1) }));
  }
  function appendDirections() {
    const directions = diceText(dice, language);
    if (!directions || pending) return;
    writeDraft(currentDraft ? `${currentDraft}\n\n${directions}` : directions);
  }
  function addSource() {
    if (pending || !sourceId) return;
    if (sources.length >= 4) { setError('lab.sourceLimit'); return; }
    const item = availableItems.find(value => String(value.id) === sourceId);
    if (item) { setError(''); onSourceIdsChange([...sourceIds, item.id]); }
  }
  async function copyDraft() {
    if (pending || !currentDraft.trim() || currentDraft.length > MAX_DRAFT_LENGTH) return;
    const request = ++copyRequestRef.current;
    setCopied(false); setError('');
    try {
      const success = await onCopy(currentDraft);
      if (request !== copyRequestRef.current) return;
      if (success) setCopied(true);
      else setError('lab.copyFailed');
    } catch {
      if (request === copyRequestRef.current) setError('lab.copyFailed');
    }
  }
  const tooLong = currentDraft.length > MAX_DRAFT_LENGTH;
  const inlineError = error || (tooLong ? 'lab.tooLong' : storageFailed ? 'lab.sessionOnly' : '');
  const categoryLabel = category => t(['context', 'subject', 'style', 'lighting', 'composition', 'constraints', 'mood', 'other'].includes(category) ? `lab.category.${category}` : 'lab.category.other');

  return <dialog id="creativeLabDialog" ref={dialogRef} className="creative-lab-dialog" aria-labelledby="creativeLabTitle" aria-describedby="creativeLabIntro" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="creative-lab-heading"><div className="creative-lab-title"><span className="creative-lab-mark"><CreativeLabIcon /></span><div><h2 id="creativeLabTitle">{t('lab.title')}</h2><p id="creativeLabIntro">{t('lab.intro')}</p></div></div><button id="closeCreativeLab" className="dialog-close" type="button" aria-label={t('common.close')} onClick={onClose}>×</button></header>
    <div className="creative-lab-layout">
      <section className="lab-references" aria-labelledby="labReferencesTitle">
        <div className="lab-section-heading"><h3 id="labReferencesTitle">{t('lab.references')}</h3><span>{t('lab.sourceCount', { count: sources.length })}</span></div>
        <div className="lab-source-picker"><label className="sr-only" htmlFor="labSourceSelect">{t('lab.chooseSource')}</label><select id="labSourceSelect" value={sourceId} disabled={pending || sources.length >= 4 || !availableItems.length} onChange={event => setSourceId(event.target.value)}><option value="">{t('lab.chooseSource')}</option>{availableItems.map(item => <option key={item.id} value={item.id}>{portraitNumber(item)} · {labelFor(item, uiLanguage)}</option>)}</select><button id="labAddSource" className="secondary-button" type="button" disabled={pending || !sourceId || sources.length >= 4} onClick={addSource}>{t('lab.addSource')}</button></div>
        <div className="lab-source-list">
          {!sources.length && <div className="lab-sources-empty"><CreativeLabIcon /><strong>{t('lab.noSources')}</strong><p>{t('lab.noSourcesHint')}</p></div>}
          {sources.map(source => <article className="lab-source" key={source.id} data-lab-source={source.id}>
            <div className="lab-source-heading"><div className="lab-source-image"><img src={source.image_url} alt={labelFor(source, uiLanguage)} /></div><div className="lab-source-name"><span>{portraitNumber(source)}</span><h4 title={labelFor(source, uiLanguage)}>{labelFor(source, uiLanguage)}</h4></div><button className="lab-remove-source" type="button" data-lab-remove-source={source.id} disabled={pending} title={t('lab.removeSource', { name: labelFor(source, uiLanguage) })} aria-label={t('lab.removeSource', { name: labelFor(source, uiLanguage) })} onClick={() => { setError(''); onSourceIdsChange(sourceIds.filter(id => id !== source.id)); }}>×</button></div>
            <div className="lab-prompt-blocks">{blocks.filter(block => block.sourceId === source.id).map(block => <label className={`lab-prompt-block${selectedKeys.has(block.key) ? ' selected' : ''}`} key={block.key}><span className="lab-block-heading"><input type="checkbox" data-lab-block={block.key} checked={selectedKeys.has(block.key)} disabled={pending} onChange={event => changeBlock(block.key, event.target.checked)} /><span>{categoryLabel(block.category)}</span></span><span className="lab-block-text" lang={language === 'zh' ? 'zh-CN' : 'en'}>{block.text}</span></label>)}</div>
          </article>)}
        </div>
        <div className="lab-compose-row"><span>{t('lab.blockCount', { count: selectedBlocks.length })}</span><button id="labCompose" className="secondary-button" type="button" disabled={pending || !selectedBlocks.length} onClick={compose}>{t('lab.compose')}</button></div>
      </section>
      <section className="lab-workspace" aria-labelledby="labDraftTitle">
        <div className="lab-section-heading"><h3>{t('lab.diceTitle')}</h3><button id="labRollDice" className="text-button lab-roll-dice" type="button" disabled={pending || DICE_CATEGORIES.every(category => locked[category])} onClick={() => { setDice(previous => rollDice(previous, locked)); setError(''); }}><span aria-hidden="true">⚄</span>{t('lab.rollDice')}</button></div>
        <div className="lab-dice-grid">{DICE_CATEGORIES.map(category => <article key={category} id={categoryId(category)} className={`lab-dice-card${locked[category] ? ' locked' : ''}`}><div className="lab-dice-heading"><strong>{categoryLabel(category)}</strong><button className="lab-dice-lock" type="button" data-lab-lock={category} aria-pressed={Boolean(locked[category])} aria-label={t(locked[category] ? 'lab.unlockNamed' : 'lab.lockNamed', { category: categoryLabel(category) })} title={t(locked[category] ? 'lab.unlockNamed' : 'lab.lockNamed', { category: categoryLabel(category) })} disabled={pending} onClick={() => setLocked(previous => ({ ...previous, [category]: !previous[category] }))}><LockIcon locked={locked[category]} /><span>{t(locked[category] ? 'lab.locked' : 'lab.lock')}</span></button></div><p data-lab-direction={category} lang={language === 'zh' ? 'zh-CN' : 'en'}>{diceOption(category, dice[category])?.[language] ?? ''}</p></article>)}</div>
        <div className="lab-dice-footer"><span>{t('lab.diceHint')}</span><button id="labAppendDice" className="text-button" type="button" disabled={pending} onClick={appendDirections}>{t('lab.appendDice')}</button></div>
        <div className="lab-draft-heading"><label id="labDraftTitle" htmlFor="labDraft">{t('lab.draftTitle')}</label><span>{t('lab.language', { language: t(language === 'zh' ? 'app.chinese' : 'app.english') })}</span></div>
        <textarea id="labDraft" value={currentDraft} disabled={pending} placeholder={t('lab.draftPlaceholder')} lang={language === 'zh' ? 'zh-CN' : 'en'} spellCheck={false} aria-invalid={Boolean(error) || tooLong} aria-describedby={inlineError ? 'labError' : copied ? 'labCopyStatus' : 'labDraftHint'} onChange={event => writeDraft(event.target.value, false)} />
        {inlineError && <p id="labError" className="lab-error" role="alert">{t(inlineError, { max: MAX_DRAFT_LENGTH })}</p>}
        <footer className="lab-draft-footer">{copied ? <span id="labCopyStatus" className="lab-copy-status" role="status">{t('lab.copied')}</span> : <span id="labDraftHint" className="lab-draft-count">{t('lab.draftCount', { count: currentDraft.length, max: MAX_DRAFT_LENGTH })}</span>}<div><button id="labUndo" className="secondary-button" type="button" disabled={pending || !history[language].length} onClick={undo}>{t('lab.undo')}</button><button id="labCopyDraft" className="primary-button" type="button" disabled={pending || !currentDraft.trim() || tooLong} onClick={copyDraft}>{t('lab.copy')}</button></div></footer>
      </section>
    </div>
  </dialog>;
}
