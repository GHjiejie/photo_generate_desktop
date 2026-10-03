import { isPhoto } from '../portraits.js';
const filters = [
  { id: 'all', icon: '✦', label: '全部肖像', count: items => items.length },
  { id: 'photo', icon: '◌', label: '摄影质感', count: items => items.filter(isPhoto).length },
  { id: 'art', icon: '✎', label: '绘画质感', count: items => items.filter(item => !isPhoto(item)).length },
];
export default function Sidebar({ portraits, activeFilter, onFilter }) {
  return <aside className="sidebar">
    <div className="window-controls-space" aria-hidden="true" />
    <div className="brand-lockup">
      <div className="brand-mark"><span /><span /><span /></div>
      <div><div className="brand-name">Portrait Studio</div><div className="brand-subtitle">PROMPT LIBRARY</div></div>
    </div>
    <div className="collection-card">
      <div className="collection-kicker">CURATED SET</div><div className="collection-title">精选女性肖像</div>
      <div className="collection-meta"><span id="totalCount">{portraits.length}</span> 张图片 · 逐张提示词</div>
    </div>
    <nav className="side-nav" aria-label="图库导航">
      {filters.map(filter => <button key={filter.id} className={`nav-item${activeFilter === filter.id ? ' active' : ''}`} type="button" data-filter={filter.id} aria-pressed={activeFilter === filter.id} onClick={() => onFilter(filter.id)}>
        <span className="nav-icon">{filter.icon}</span><span>{filter.label}</span><span className="nav-count" id={`${filter.id}Count`}>{filter.count(portraits)}</span>
      </button>)}
    </nav>
    <div className="sidebar-tip"><div className="tip-icon">⌘</div><div><strong>快速复制</strong><p>把鼠标移到图片上，点击复制图标。</p></div></div>
    <div className="sidebar-footer"><span className="status-dot" />本地桌面图库</div>
  </aside>;
}
