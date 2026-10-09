import { useEffect, useRef, useState } from 'react'
import { resumeHub } from './lib/hubBridge'
import { loadCloudConfig } from './lib/cloud'
import { deviceTag } from './services/device'
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useApp } from './store/app'
import { Toasts, Button } from './ui/kit'
import { can } from './services/context'
import { accessibleModules, currentModule } from './services/modules'
import { moduleLabel } from './modules/registry'
import Modules from './pages/Modules'
import { Setup, Login } from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Seasons from './pages/Seasons'
import Fields from './pages/Fields'
import FieldRecord from './pages/FieldRecord'
import Seedbeds from './pages/Seedbeds'
import Operations from './pages/Operations'
import Inventory from './pages/Inventory'
import Costs from './pages/Costs'
import Transplanting from './pages/Transplanting'
import Harvest from './pages/Harvest'
import Barns from './pages/Barns'
import Curing from './pages/Curing'
import Starking from './pages/Starking'
import Grading from './pages/Grading'
import Bales from './pages/Bales'
import Sales from './pages/Sales'
import Buyers from './pages/Buyers'
import Activity from './pages/Activity'
import { canSeeAnyActivity } from './services/activity'
import Contractors from './pages/Contractors'
import Contracts from './pages/Contracts'
import Access from './pages/Access'
import Portal from './pages/Portal'
import Join from './pages/Join'
import Labour from './pages/Labour'
import FieldTerminal from './pages/FieldTerminal'
import Machinery from './pages/Machinery'
import Budgets from './pages/Budgets'
import Profitability from './pages/Profitability'
import Ask from './pages/Ask'
import SyncPage from './pages/Sync'

/** `perm`: needed to see the item; `anyOf`: any one of these is enough. */
interface NavItem { to?: string; label: string; perm?: string; anyOf?: string[] }
/** `module`: the group shows only while that module is the one being worked in; no `module` means shared by every module. */
const NAV: { group: string; module?: string; items: NavItem[] }[] = [
  { group: '', items: [{ to: '/', label: 'Dashboard' }] },
  { group: 'Production', module: 'tobacco', items: [
    { to: '/seedbeds', label: 'Seedbeds', perm: 'production.seedbed.view' }, { to: '/fields', label: 'Fields', perm: 'production.field.view' },
    { to: '/operations', label: 'Operations', perm: 'production.operation.view' },
    { to: '/transplanting', label: 'Transplanting', perm: 'production.transplant.view' }, { to: '/harvest', label: 'Harvest', perm: 'production.harvest.view' }] },
  { group: 'Curing', module: 'tobacco', items: [{ to: '/barns', label: 'Barns', perm: 'curing.barn.view' }, { to: '/curing', label: 'Curing cycles', perm: 'curing.cycle.view' }, { to: '/starking', label: 'Starking', perm: 'curing.storage.view' }] },
  { group: 'Quality', module: 'tobacco', items: [{ to: '/grading', label: 'Grading', perm: 'quality.grading.view' }, { to: '/bales', label: 'Bales', perm: 'quality.bale.view' }] },
  { group: 'Marketing', module: 'tobacco', items: [{ to: '/sales', label: 'Sales', perm: 'marketing.sale.view' }, { to: '/buyers', label: 'Buyers', perm: 'marketing.buyer.view' }] },
  { group: 'Resources', items: [{ to: '/inventory', label: 'Inventory', perm: 'resources.inventory.view' }, { to: '/labour', label: 'Labour', perm: 'resources.labour.view' }, { to: '/machinery', label: 'Machinery', perm: 'resources.machinery.view' }] },
  { group: 'Finance', items: [{ to: '/costs', label: 'Costs', perm: 'finance.cost.view' }, { to: '/budgets', label: 'Budgets', perm: 'finance.budget.view' }, { to: '/profitability', label: 'Profitability', perm: 'finance.cost.view' }] },
  { group: 'Contracts', module: 'tobacco', items: [{ to: '/contracts', label: 'Programmes', perm: 'contracts.contract.view' }, { to: '/contractors', label: 'Contractors', perm: 'contracts.contract.view' }] },
  { group: 'Brain', items: [{ to: '/activity', label: 'Activity' }, { to: '/ask', label: 'Ask', anyOf: ['brain.chat.ask', 'brain.chat.cloud'] }] },
  { group: 'Settings', items: [{ to: '/seasons', label: 'Seasons', perm: 'settings.season.view' }, { to: '/modules', label: 'Modules', perm: 'settings.modules.manage' }, { to: '/access', label: 'Users & access' },
    { to: '/sync', label: 'Sync & backup' }] },
]

const WIDE = '(min-width: 768px)'
/** True on screens wide enough for a permanent sidebar. Without matchMedia (jsdom, very old webviews) the layout is treated as wide. */
function useWide() {
  const query = () => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches
  const [wide, setWide] = useState(query)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const m = window.matchMedia(WIDE); const h = () => setWide(m.matches); m.addEventListener?.('change', h); return () => m.removeEventListener?.('change', h)
  }, [])
  return wide
}
/** Folding the sidebar away on a desktop is a per-device convenience, so it lives in localStorage (and works without it). */
const FOLD_KEY = 'fp.sidebar.folded'
const readFolded = () => { try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false } }
const saveFolded = (v: boolean) => { try { localStorage.setItem(FOLD_KEY, v ? '1' : '0') } catch { /* private mode */ } }

/** Pending changes, worded so that a farm with no cloud set up does not look as if something is broken. */
export function syncLabel(pending: number, cloudSetUp: boolean) {
  if (!pending) return 'All changes synced'
  const n = `${pending} change${pending > 1 ? 's' : ''}`
  return cloudSetUp ? `${n} awaiting sync` : `${n} saved on this device · cloud sync not set up`
}

/** Keeps the current page's menu item in view: after each navigation and whenever the drawer opens. */
function ActiveIntoView({ open }: { open: boolean }) {
  const { pathname } = useLocation()
  useEffect(() => { document.querySelector('#sidebar nav [aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' }) }, [pathname, open])
  return null
}

const Bars = () => <svg aria-hidden="true" viewBox="0 0 20 20" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>

function Shell() {
  const { ctx, signOut, db, fieldMode } = useApp()
  const [pending, setPending] = useState(0)
  const rev = useApp(s => s.rev)
  useEffect(() => { setPending(db!.pendingSync()) }, [rev, db])
  useEffect(() => { if (!fieldMode && db) void resumeHub(db) }, [fieldMode, db])
  const wide = useWide()
  const [folded, setFolded] = useState(readFolded)   // desktop: sidebar folded away
  const [open, setOpen] = useState(false)            // phone: drawer open
  const menuBtn = useRef<HTMLButtonElement>(null); const closeBtn = useRef<HTMLButtonElement>(null); const refocusMenu = useRef(false)
  const shown = wide ? !folded : open
  useEffect(() => { if (wide) setOpen(false) }, [wide])
  useEffect(() => { if (!wide && open) closeBtn.current?.focus() }, [wide, open])
  useEffect(() => { if (refocusMenu.current && !shown) { refocusMenu.current = false; menuBtn.current?.focus() } })
  useEffect(() => {
    if (wide || !open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { refocusMenu.current = true; setOpen(false) } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [wide, open])
  if (!ctx) return null
  if (fieldMode) return <FieldTerminal />
  const showMenu = () => { if (wide) { setFolded(false); saveFolded(false) } else setOpen(true) }
  const hideMenu = () => { refocusMenu.current = true; if (wide) { setFolded(true); saveFolded(true) } else setOpen(false) }
  const mods = accessibleModules(ctx, p => can(ctx, p)); const cur = currentModule(ctx)
  const sync = syncLabel(pending, !!loadCloudConfig().url || deviceTag(db!) !== '')
  return (
    <HashRouter>
      <ActiveIntoView open={open} />
      <div className="h-full flex">
        {!wide && open && <div className="fixed inset-0 z-30 bg-black/30" aria-hidden="true" onClick={() => setOpen(false)} />}
        <aside id="sidebar" aria-label="Sidebar" inert={!shown || undefined}
          className={`bg-white border-r border-gray-200 flex flex-col ${wide ? `w-56 shrink-0 ${folded ? 'hidden' : ''}` : `fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] shadow-xl transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full'}`}`}>
          <div className="pl-4 pr-2 py-3 border-b border-gray-200 flex items-center gap-2">
            <div className="min-w-0 flex-1"><div className="font-semibold text-brand-700 leading-tight">farmPLAN Tobacco</div><div className="text-xs text-gray-500">Zimbabwe</div></div>
            <button ref={closeBtn} type="button" onClick={hideMenu} aria-label={wide ? 'Hide menu' : 'Close menu'} title={wide ? 'Hide menu' : undefined}
              className="w-9 h-9 grid place-items-center rounded text-gray-600 hover:bg-gray-100 text-lg">{wide ? '«' : '×'}</button>
          </div>
          {mods.length > 1 && <div className="px-4 py-2 border-b border-gray-200">
            <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1" htmlFor="module-picker">Module</label>
            <select id="module-picker" value={cur} onChange={e => useApp.getState().setModule(e.target.value)} className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm">
              {mods.map(id => <option key={id} value={id}>{moduleLabel(id)}</option>)}</select>
          </div>}
          <nav className="flex-1 overflow-y-auto py-2 text-sm" aria-label="Main">
            {NAV.filter(g => !g.module || g.module === cur).map(g => {
              const items = g.items.filter(i => (i.anyOf ? i.anyOf.some(p => can(ctx, p)) : !i.perm || can(ctx, i.perm)) || i.label === 'Users & access' || (i.to === '/activity' && canSeeAnyActivity(ctx)))
              if (!items.length) return null
              return (
                <div key={g.group || 'top'} className="mb-1">
                  {g.group && <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wider text-gray-500">{g.group}</div>}
                  {items.map(i => i.to
                    ? <NavLink key={i.label} to={i.to} end={i.to === '/'} onClick={() => { if (!wide) setOpen(false) }} className={({ isActive }) => `block px-4 py-1.5 ${isActive ? 'bg-brand-50 text-brand-800 font-medium border-r-2 border-brand-600' : 'text-gray-700 hover:bg-gray-50'}`}>{i.label}</NavLink>
                    : <div key={i.label} className="px-4 py-1.5 text-gray-300 flex justify-between" title="Planned for a later phase">{i.label}<span className="text-[10px] self-center">soon</span></div>)}
                </div>
              )
            })}
          </nav>
          <div className="border-t border-gray-200 p-3 text-xs">
            <div className="font-medium text-gray-800 truncate">{ctx.actor?.name}</div>
            <div className="text-gray-500 mb-2">{sync}</div>
            <Button small onClick={() => useApp.getState().setFieldMode(true)} className="w-full mb-1">Field terminal view</Button>
            <Button small onClick={signOut} className="w-full">Sign out</Button>
          </div>
        </aside>
        <div className="flex-1 min-w-0 flex flex-col">
          {(!wide || folded) && <header className="h-12 shrink-0 bg-white border-b border-gray-200 flex items-center gap-2 px-2 sm:px-4">
            <button ref={menuBtn} type="button" onClick={showMenu} aria-label="Open menu" aria-controls="sidebar" aria-expanded={shown}
              className="w-10 h-10 grid place-items-center rounded text-gray-700 hover:bg-gray-100"><Bars /></button>
            <span className="font-semibold text-brand-700 whitespace-nowrap">farmPLAN Tobacco</span>
            {pending > 0 && <span className="ml-auto shrink-0 rounded-full bg-amber-100 text-amber-900 text-xs px-2 py-0.5" title={sync}>{pending} not synced</span>}
          </header>}
        <main className="flex-1 min-w-0 overflow-y-auto"><div className="max-w-6xl mx-auto p-4 sm:p-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/seedbeds" element={<Seedbeds />} />
            <Route path="/fields" element={<Fields />} />
            <Route path="/fields/:fieldNo" element={<FieldRecord />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/transplanting" element={<Transplanting />} />
            <Route path="/harvest" element={<Harvest />} />
            <Route path="/barns" element={<Barns />} />
            <Route path="/curing" element={<Curing />} />
            <Route path="/starking" element={<Starking />} />
            <Route path="/grading" element={<Grading />} />
            <Route path="/bales" element={<Bales />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/buyers" element={<Buyers />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/brain" element={<Navigate to="/ask" replace />} />
            <Route path="/contracts" element={<Contracts />} />
            <Route path="/contractors" element={<Contractors />} />
            <Route path="/machinery" element={<Machinery />} />
            <Route path="/labour" element={<Labour />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/budgets" element={<Budgets />} />
            <Route path="/profitability" element={<Profitability />} />
            <Route path="/ask" element={<Ask />} />
            <Route path="/costs" element={<Costs />} />
            <Route path="/seasons" element={<Seasons />} />
            <Route path="/modules" element={<Modules />} />
            <Route path="/access" element={<Access />} />
            <Route path="/sync" element={<SyncPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div></main>
        </div>
      </div>
    </HashRouter>
  )
}

export default function App() {
  const { phase, boot, error } = useApp()
  useEffect(() => { void boot() }, [boot])
  return (
    <>
      {phase === 'booting' && <div className="h-full grid place-items-center text-gray-500">Opening farm database…</div>}
      {phase === 'error' && <div className="h-full grid place-items-center text-red-700 p-8">Could not open the local database: {error}</div>}
      {phase === 'setup' && <Setup />}
      {phase === 'login' && <Login />}
      {phase === 'ready' && <Shell />}
      {phase === 'portal' && <Portal />}
      {phase === 'join' && <Join />}
      {(phase === 'setup' || phase === 'login') && <button onClick={() => useApp.getState().openPortal()} className="fixed bottom-4 left-4 text-sm text-brand-700 underline">Contractor / extension portal</button>}
      <Toasts />
    </>
  )
}
