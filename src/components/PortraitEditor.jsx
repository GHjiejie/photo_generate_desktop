import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isPhoto, portraitNumber, promptFor } from '../portraits.js';
import { useI18n } from '../i18n.jsx';

export default function PortraitEditor({ editor, pending, saving, canSave, onCancel, onChooseImage, onSave, onReviewConflict, onAcknowledgeConflict }) {
  const { t, errorText } = useI18n();
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState({ id: '', label: '', type: 'photo', en: '', zh: '' });
  useLayoutEffect(() => {
    if (!editor) return;
    const item = editor.item;
    setDraft({ id: item?.id ?? editor.nextId, label: item?.label ?? '', type: item?.type ?? (item && !isPhoto(item) ? 'art' : 'photo'), en: promptFor(item, 'en'), zh: promptFor(item, 'zh') });
  }, [editor?.session]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (editor && !dialog.open) dialog.showModal();
    else if (!editor && dialog.open) dialog.close();
  }, [editor]);
  function field(name, value) { setDraft(previous => ({ ...previous, [name]: value })); }
  const previewURL = editor?.image?.previewURL ?? editor?.item?.image_url;
  return <dialog ref={dialogRef} id="portraitEditor" className="management-dialog editor-dialog" aria-labelledby="portraitEditorTitle" onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!pending && !editor?.conflict) onSave({ id: Number(draft.id), label: draft.label, type: editor?.mode === 'edit' ? editor.item?.type ?? draft.type : draft.type, prompts: { en: draft.en, zh: draft.zh } }); }}>
      <div className="management-heading"><div><div className="detail-kicker">{t('common.localPortrait')}</div><h2 id="portraitEditorTitle">{t(editor?.mode === 'edit' ? 'editor.editTitle' : 'editor.importTitle')}</h2><p>{t(editor?.mode === 'edit' ? 'editor.editHint' : 'editor.importHint')}</p></div><button className="dialog-close" type="button" aria-label={t('editor.close')} disabled={pending} onClick={onCancel}>×</button></div>
      <div className="editor-body">
        <div className="editor-image-column"><div className="editor-image-preview">{previewURL ? <img id="portraitImagePreview" src={previewURL} alt={t('editor.previewAlt')} /> : <div className="editor-image-placeholder"><span>＋</span>{t('editor.chooseLocalImage')}</div>}</div><button id="portraitChooseImage" className="secondary-button" type="button" disabled={pending || !canSave} title={!canSave ? t('common.desktopOnly') : undefined} onClick={onChooseImage}>{t(previewURL ? 'editor.replaceImage' : 'editor.importImage')}</button><p className="field-note">{t('editor.imageHint')}</p>{(editor?.image?.name || editor?.item?.image) && <p className="field-note">{t('editor.currentImage', { name: editor.image?.name ?? editor.item.image })}</p>}</div>
        <div className="editor-fields"><div className="editor-metadata"><label>{t('editor.id')}<input id="portraitId" type="number" min="1" max="999999" step="1" required disabled={pending || editor?.mode === 'edit'} value={draft.id} onChange={event => field('id', event.target.value)} /></label><label>{t('editor.name')}<input id="portraitLabel" type="text" maxLength="160" required disabled={pending} value={draft.label} onChange={event => field('label', event.target.value)} /></label></div>
          <label className="prompt-field">{t('editor.promptEn')}<textarea id="portraitPromptEn" lang="en" required maxLength="65536" disabled={pending} value={draft.en} onChange={event => field('en', event.target.value)} placeholder={t('editor.promptEnPlaceholder')} /></label>
          <label className="prompt-field">{t('editor.promptZh')}<textarea id="portraitPromptZh" lang="zh-CN" required maxLength="65536" disabled={pending} value={draft.zh} onChange={event => field('zh', event.target.value)} placeholder={t('editor.promptZhPlaceholder')} /></label>
        </div>
      </div>
      {editor?.error && <div id="portraitFormError" className="form-error" role="alert">{errorText(editor.error)}</div>}
      {editor?.conflict && <div className="conflict-panel"><p>{t('editor.conflictHint')}</p>{!editor.reviewOpen ? <button id="portraitReviewConflict" className="secondary-button" type="button" disabled={pending} onClick={onReviewConflict}>{t('editor.reviewLatest')}</button> : <>{editor.mode === 'edit' && editor.conflict.item ? <div className="conflict-record"><strong>{portraitNumber(editor.conflict.item)} · {editor.conflict.item.label}</strong><p>{t('editor.originalImage', { name: editor.conflict.item.image })}</p><details><summary>{t('editor.viewCurrentEn')}</summary><pre>{promptFor(editor.conflict.item, 'en')}</pre></details><details><summary>{t('editor.viewCurrentZh')}</summary><pre>{promptFor(editor.conflict.item, 'zh')}</pre></details></div> : <p>{editor.mode === 'edit' ? t('editor.removed') : t('editor.currentCount', { count: editor.conflict.items.length })}</p>}{(editor.mode !== 'edit' || editor.conflict.item) && <button id="portraitAcknowledgeConflict" className="secondary-button" type="button" disabled={pending} onClick={onAcknowledgeConflict}>{t('editor.continueSave')}</button>}</>}</div>}
      <div className="management-actions"><button id="portraitCancel" className="secondary-button" type="button" disabled={pending} onClick={onCancel}>{t('common.cancel')}</button><button id="portraitSave" className="primary-button" type="submit" title={!canSave ? t('common.desktopOnly') : undefined} disabled={pending || !canSave || Boolean(editor?.conflict)}>{t(saving ? 'editor.saving' : 'editor.save')}</button></div>
    </form>
  </dialog>;
}
