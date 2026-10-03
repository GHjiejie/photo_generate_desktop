import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isPhoto, portraitNumber, promptFor } from '../portraits.js';

export default function PortraitEditor({ editor, pending, saving, canSave, onCancel, onChooseImage, onSave, onReviewConflict, onAcknowledgeConflict }) {
  const dialogRef = useRef(null);
  const [draft, setDraft] = useState({ id: '', label: '', type: 'photo', en: '', zh: '' });
  useLayoutEffect(() => {
    if (!editor) return;
    const item = editor.item;
    setDraft({ id: item?.id ?? editor.nextId, label: item?.label ?? '', type: item && !isPhoto(item) ? 'art' : 'photo', en: promptFor(item, 'en'), zh: promptFor(item, 'zh') });
  }, [editor?.session]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (editor && !dialog.open) dialog.showModal();
    else if (!editor && dialog.open) dialog.close();
  }, [editor]);
  function field(name, value) { setDraft(previous => ({ ...previous, [name]: value })); }
  const previewURL = editor?.image?.previewURL ?? editor?.item?.image_url;
  return <dialog ref={dialogRef} id="portraitEditor" className="management-dialog editor-dialog" aria-labelledby="portraitEditorTitle" onCancel={event => { event.preventDefault(); if (!pending) onCancel(); }}>
    <form onSubmit={event => { event.preventDefault(); if (!pending && !editor?.conflict) onSave({ id: Number(draft.id), label: draft.label, type: draft.type, prompts: { en: draft.en, zh: draft.zh } }); }}>
      <div className="management-heading"><div><div className="detail-kicker">LOCAL PORTRAIT</div><h2 id="portraitEditorTitle">{editor?.mode === 'edit' ? '编辑肖像' : '导入图片与提示词'}</h2><p>{editor?.mode === 'edit' ? '修改会保存到当前素材库；更换图片时请选择本机的图片文件。' : '选择本机的一张图片，在右侧填写中英提示词，再保存到左侧显示的素材位置。'}</p></div><button className="dialog-close" type="button" aria-label="关闭编辑表单" disabled={pending} onClick={onCancel}>×</button></div>
      <div className="editor-body">
        <div className="editor-image-column"><div className="editor-image-preview">{previewURL ? <img id="portraitImagePreview" src={previewURL} alt="待保存的肖像图片" /> : <div className="editor-image-placeholder"><span>＋</span>选择本机的图片文件</div>}</div><button id="portraitChooseImage" className="secondary-button" type="button" disabled={pending} onClick={onChooseImage}>{previewURL ? '更换图片' : '导入图片'}</button><p className="field-note">选择 PNG、JPEG 或 WebP 图片（最大 30 MiB）。提示词在右侧填写；导入保存副本，原图保留。</p>{(editor?.image?.name || editor?.item?.image) && <p className="field-note">当前图片：{editor.image?.name ?? editor.item.image}</p>}</div>
        <div className="editor-fields"><div className="editor-metadata"><label>编号<input id="portraitId" type="number" min="1" max="999999" step="1" required disabled={pending || editor?.mode === 'edit'} value={draft.id} onChange={event => field('id', event.target.value)} /></label><label>名称<input id="portraitLabel" type="text" maxLength="160" required disabled={pending} value={draft.label} onChange={event => field('label', event.target.value)} /></label><label>质感<select id="portraitType" disabled={pending} value={draft.type} onChange={event => field('type', event.target.value)}><option value="photo">摄影质感</option><option value="art">绘画质感</option></select></label></div>
          <label className="prompt-field">完整英文提示词<textarea id="portraitPromptEn" lang="en" required maxLength="65536" disabled={pending} value={draft.en} onChange={event => field('en', event.target.value)} placeholder="粘贴完整英文提示词，保留全部细节和限制条件。" /></label>
          <label className="prompt-field">完整中文提示词<textarea id="portraitPromptZh" lang="zh-CN" required maxLength="65536" disabled={pending} value={draft.zh} onChange={event => field('zh', event.target.value)} placeholder="填写对应的完整中文提示词。" /></label>
        </div>
      </div>
      {editor?.error && <div id="portraitFormError" className="form-error" role="alert">{editor.error}</div>}
      {editor?.conflict && <div className="conflict-panel"><p>当前输入已保留。保存前，请核对图库中的最新记录。</p>{!editor.reviewOpen ? <button id="portraitReviewConflict" className="secondary-button" type="button" disabled={pending} onClick={onReviewConflict}>核对最新记录</button> : <>{editor.mode === 'edit' && editor.conflict.item ? <div className="conflict-record"><strong>{portraitNumber(editor.conflict.item)} · {editor.conflict.item.label} · {isPhoto(editor.conflict.item) ? '摄影质感' : '绘画质感'}</strong><p>原图：{editor.conflict.item.image}</p><details><summary>查看当前英文提示词</summary><pre>{promptFor(editor.conflict.item, 'en')}</pre></details><details><summary>查看当前中文提示词</summary><pre>{promptFor(editor.conflict.item, 'zh')}</pre></details></div> : <p>{editor.mode === 'edit' ? '该肖像已被移除，请取消编辑。' : `图库现有 ${editor.conflict.items.length} 张；请确认编号没有重复。`}</p>}{(editor.mode !== 'edit' || editor.conflict.item) && <button id="portraitAcknowledgeConflict" className="secondary-button" type="button" disabled={pending} onClick={onAcknowledgeConflict}>已核对，继续保存当前输入</button>}</>}</div>}
      <div className="management-actions"><button id="portraitCancel" className="secondary-button" type="button" disabled={pending} onClick={onCancel}>取消</button><button id="portraitSave" className="primary-button" type="submit" disabled={pending || !canSave || Boolean(editor?.conflict)}>{saving ? '正在保存…' : '保存肖像'}</button></div>
    </form>
  </dialog>;
}
