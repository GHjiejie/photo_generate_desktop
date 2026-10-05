import { useState } from 'react';
import { useI18n } from '../i18n.jsx';
import Settings from './Settings.jsx';
import { StarIcon } from './FavoriteButton.jsx';
export default function Sidebar({ portraits, favoriteCount, favoritesOnly, onFavoriteView, favoritesAvailable, pending }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('portraitStudio.sidebarCollapsed') === 'true'; }
    catch { return false; }
  });
  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem('portraitStudio.sidebarCollapsed', String(next)); } catch { /* The current view can still be toggled. */ }
  }
  return <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} data-collapsed={collapsed}>
    <div className="window-controls-space" aria-hidden="true" />
    <div className="brand-row brand-toggle-row"><div className="brand-lockup"><div className="brand-mark"><span /><span /><span /></div><div className="brand-text"><div className="brand-name">Portrait Studio</div><div className="brand-subtitle">{t('sidebar.subtitle')}</div></div></div><button id="sidebarToggle" className="sidebar-toggle icon-button" type="button" aria-label={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')} title={t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')} aria-expanded={!collapsed} aria-controls="sidebarContent" onClick={toggleSidebar}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={collapsed ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} /></svg></button></div>
    <div id="sidebarContent" className="sidebar-content">
    <div className="collection-card"><div className="collection-kicker">{t('sidebar.collection')}</div><div className="collection-title">{t('sidebar.title')}</div><div className="collection-meta" id="totalCount">{t('sidebar.count', { count: portraits.length })}</div></div>
    <nav className="side-nav" aria-label={t('sidebar.navigation')}>
      <button id="allImages" className={`nav-item${!favoritesOnly ? ' active' : ''}`} type="button" aria-label={t('sidebar.all')} title={t('sidebar.all')} aria-pressed={!favoritesOnly} disabled={pending} onClick={() => onFavoriteView(false)}><span className="nav-icon" aria-hidden="true">✦</span><span className="nav-label">{t('sidebar.all')}</span><span className="nav-count" id="allCount">{portraits.length}</span></button>
      <button id="favoriteImages" className={`nav-item${favoritesOnly ? ' active' : ''}`} type="button" aria-label={t('favorites.view')} title={t('favorites.view')} aria-pressed={favoritesOnly} disabled={pending || !favoritesAvailable} onClick={() => onFavoriteView(true)}><span className="nav-icon"><StarIcon filled={favoritesOnly} /></span><span className="nav-label">{t('favorites.view')}</span><span className="nav-count" id="favoriteCount">{favoriteCount}</span></button>
    </nav>
    </div>
    <Settings />
  </aside>;
}
