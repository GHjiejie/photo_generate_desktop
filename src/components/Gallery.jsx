import { portraitNumber } from '../portraits.js';
import PromptLanguage from './PromptLanguage.jsx';
function PortraitCard({ item, index, copied, onOpen, onCopy }) {
  return <article className="portrait-card" tabIndex={0} aria-label={`${portraitNumber(item)} ${item.label}`} onClick={() => onOpen(item.id)} onKeyDown={event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item.id); }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); onCopy(item, true); }
  }}>
    <div className="portrait-image-wrap">
      <img className="portrait-image" loading={index < 5 ? 'eager' : 'lazy'} src={item.image_url} alt={`${item.label} · ${portraitNumber(item)}`} />
      <button className={`copy-button${copied ? ' copied' : ''}`} type="button" title="复制完整提示词" aria-label={`复制 ${item.label} 的完整提示词`} onClick={event => { event.stopPropagation(); onCopy(item, true); }}>{copied ? '✓' : '⧉'}</button>
    </div>
    <div className="card-overlay"><div className="card-number">{portraitNumber(item)}</div><div className="card-title">{item.label}</div><div className="card-prompt-hint">点击查看完整提示词</div></div>
  </article>;
}
export default function Gallery({ items, dense, copiedId, onOpen, onCopy, language, onLanguage, configured = false, query = '' }) {
  return <>
    <div className="toolbar"><div className="result-count" id="resultCount">显示 {items.length} 张</div><PromptLanguage language={language} onLanguage={onLanguage} /><div className="toolbar-note"><span className="legend-dot" />悬停图片可复制提示词</div></div>
    <section className={`gallery${dense ? ' dense' : ''}`} id="gallery" aria-live="polite">
      {items.map((item, index) => <PortraitCard key={item.id} item={item} index={index} copied={copiedId === item.id} onOpen={onOpen} onCopy={onCopy} />)}
    </section>
    <div className="empty-state" id="emptyState" hidden={items.length !== 0}><div className="empty-symbol">⌁</div><h2>{configured && !query ? '素材库还没有肖像' : '没有找到匹配的肖像'}</h2><p>{configured && !query ? '点击左侧“新增肖像”，导入图片和中英提示词。' : '试试其他名称、编号或提示词。'}</p></div>
  </>;
}
