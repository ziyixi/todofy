import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router'
import { Activity, ArrowUpRight, Boxes, ChevronDown, CircleHelp, ClipboardList, Inbox, Mail, Menu, Settings2, Webhook, X } from 'lucide-react'
import { api } from '../api/client'
import { CopyButton, formatBytes } from '../components/UI'
import InboxPage from '../pages/InboxPage'
import MessagePage from '../pages/MessagePage'
import DeliveriesPage from '../pages/DeliveriesPage'
import DeliveryPage from '../pages/DeliveryPage'
import EndpointsPage from '../pages/EndpointsPage'
import SettingsPage from '../pages/SettingsPage'
import SetupPage from '../pages/SetupPage'

const navItems = [
  { to: '/inbox', label: '收件箱', icon: Inbox },
  { to: '/deliveries', label: '投递记录', icon: ClipboardList },
  { to: '/endpoints', label: 'Webhook 目标', icon: Webhook },
  { to: '/settings', label: '设置', icon: Settings2 },
]

function Shell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 300_000, refetchInterval: 300_000, refetchIntervalInBackground: false })
  const receiveAddress = settings.data?.receive_address || overview.data?.receive_address
  const isPaused = settings.data?.effective_send_paused ?? settings.data?.send_paused

  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-icon"><Mail size={21} strokeWidth={2.3} /></div><div className="brand-name">mail<span>hero</span><small>收件工作台</small></div><button className="mobile-close" aria-label="关闭菜单" onClick={() => setMenuOpen(false)}><X size={20}/></button></div>
      <div className="sidebar-caption">工作空间</div>
      <nav className="nav-list" aria-label="主导航">{navItems.map(({ to, label, icon: Icon }) => <NavLink onClick={() => setMenuOpen(false)} key={to} to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Icon size={18} strokeWidth={1.9}/><span>{label}</span>{to === '/deliveries' && !!overview.data?.failed_count && <span className="nav-count">{overview.data.failed_count}</span>}</NavLink>)}</nav>
      <div className="sidebar-bottom"><Link to="/setup" onClick={() => setMenuOpen(false)} className="help-link"><CircleHelp size={17}/> 接入指引 <ArrowUpRight size={14}/></Link><div className="sidebar-service"><span className="service-light"/><span>Mail Hero</span><span className="service-version">个人版</span></div></div>
    </aside>
    {menuOpen && <button className="mobile-scrim" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}
    <div className="main-area">
      <header className="topbar"><div className="topbar-left"><button className="menu-button" aria-label="打开菜单" onClick={() => setMenuOpen(true)}><Menu size={21}/></button><div className="breadcrumb"><span>Mail Hero</span><span className="slash">/</span><strong>{navItems.find(item => location.pathname.startsWith(item.to))?.label || (location.pathname.startsWith('/setup') ? '接入指引' : '邮件')}</strong></div></div>
        <div className="topbar-right">{isPaused && <Link to="/settings" className="topbar-pause"><span className="pause-dot"/>投递已暂停</Link>}{receiveAddress ? <div className="address-pill"><span className="address-dot"/><code>{receiveAddress}</code><CopyButton value={receiveAddress} label="复制地址"/></div> : <Link to="/setup" className="address-loading">检查收信地址 <ChevronDown size={15}/></Link>}</div>
      </header>
      <main className="main-content">{(overview.data?.warnings?.length || 0) > 0 && <div className="warning-banner"><Activity size={17} /><span>{overview.data?.warnings?.join(' · ')}</span><Link to="/settings">查看状态</Link></div>}{children}</main>
      <footer className="page-footer"><span>你的邮件保存在私有邮件存储中</span><span>{overview.data?.storage_bytes != null ? `已用 ${formatBytes(overview.data.storage_bytes)}` : 'Mail Hero'}<span className="footer-divider">·</span><Link to="/setup">接入帮助</Link></span></footer>
    </div>
  </div>
}

export default function App() {
  return <Shell><Routes>
    <Route path="/" element={<Navigate to="/inbox" replace />} />
    <Route path="/inbox" element={<InboxPage />} />
    <Route path="/messages/:id" element={<MessagePage />} />
    <Route path="/deliveries" element={<DeliveriesPage />} />
    <Route path="/deliveries/:id" element={<DeliveryPage />} />
    <Route path="/endpoints" element={<EndpointsPage />} />
    <Route path="/settings" element={<SettingsPage />} />
    <Route path="/setup" element={<SetupPage />} />
    <Route path="*" element={<div className="not-found"><Boxes size={37}/><h1>找不到这个页面</h1><p>地址可能已经改变。</p><Link className="button button-primary" to="/inbox">返回收件箱</Link></div>} />
  </Routes></Shell>
}
