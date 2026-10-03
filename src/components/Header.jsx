export default function Header({ query, onQuery, searchRef, dense, onToggleDensity }) {
  return <header className="topbar">
    <div className="title-block"><div className="crumb">COLLECTION / PORTRAITS</div><h1>灵感肖像集</h1><p>每一张图，都对应一段可以直接复用的完整提示词。</p></div>
    <div className="topbar-actions">
      <label className="search-box"><span className="search-icon">⌕</span><input ref={searchRef} id="searchInput" type="search" aria-label="搜索风格或编号" placeholder="搜索风格或编号" autoComplete="off" value={query} onChange={event => onQuery(event.target.value)} /><kbd>⌘ K</kbd></label>
      <button className={`icon-button${dense ? ' active' : ''}`} id="gridToggle" type="button" aria-label="切换网格密度" aria-pressed={dense} title="切换网格密度" onClick={onToggleDensity}>▦</button>
    </div>
  </header>;
}
