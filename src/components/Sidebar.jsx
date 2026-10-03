import { isPhoto } from '../portraits.js';
const filters = [
  { id: 'all', icon: '✦', label: '全部肖像', count: items => items.length },
  { id: 'photo', icon: '◌', label: '摄影质感', count: items => items.filter(isPhoto).length },
  { id: 'art', icon: '✎', label: '绘画质感', count: items => items.filter(item => !isPhoto(item)).length },
];
export default function Sidebar({ portraits, activeFilter, onFilter, library, desktop, editable, pending, onConfigure, onRefresh, onCreate, onUpdates }) {
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
    <div className="library-controls">
      <div className="sidebar-footer" id="libraryStatus"><span className={`status-dot${!library.configured || !library.writable ? ' readonly' : ''}`} />{library.configured ? (library.writable ? '本地素材库 · 可编辑' : '本地素材库 · 只读') : '内置精选 · 只读'}</div>
      <div className="library-location-help" id="libraryLocationHelp"><strong>素材保存位置</strong><p>{library.configured ? '图片和中英提示词保存在下面的文件夹。选择后会记住，切换仅更换素材库。' : '选一个本机可写文件夹，长期保存图片和中英提示词。使用原项目时可选项目文件夹；选择后会记住。'}</p></div>
      {library.configured && <div className="library-root" id="libraryRoot" title={library.root}>{library.root}</div>}
      <button id="libraryCreate" className="primary-button library-create" type="button" disabled={!editable || pending} onClick={onCreate}>＋ 导入图片与提示词</button>
      <div className="library-control-row"><button id="libraryConfigure" className="secondary-button" type="button" disabled={!desktop || pending} onClick={onConfigure}>{library.configured ? '切换素材库' : '选择保存文件夹'}</button><button id="libraryRefresh" className="secondary-button library-refresh" type="button" aria-label="刷新本地素材" title="刷新本地素材" disabled={!desktop || pending} onClick={onRefresh}>↻</button></div>
      <button id="appUpdate" className="secondary-button app-update-button" type="button" disabled={pending} onClick={onUpdates}><span>↥</span> 检查更新 / 升级最新版</button>
    </div>
  </aside>;
}
