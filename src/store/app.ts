import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url'
import { create } from 'zustand'
import { Db, IndexedDbPersistence } from '../db/database'
import { deviceTag } from '../services/device'
import { isInitialised, resumeSession } from '../services/setup'
import type { Ctx } from '../services/context'

/**
 * A sign-in survives a page reload but not closing the tab or app window (sessionStorage), and lasts at most SESSION_HOURS.
 * Signing out ends it. Storage can be unavailable (private mode, previews): then a reload simply asks for the PIN again.
 */
const SESSION_KEY = 'fp.session'; export const SESSION_HOURS = 12
const saveSession = (userId: string) => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId, at: Date.now() })) } catch { /* unavailable */ } }
const clearSession = () => { try { sessionStorage.removeItem(SESSION_KEY) } catch { /* unavailable */ } }
const readSession = (): string | null => {
  try { const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as { userId?: string; at?: number } | null
    return s?.userId && s.at && Date.now() - s.at < SESSION_HOURS * 3600e3 ? s.userId : null } catch { return null }
}

/** Which module this person works in is a per-device convenience (like the folded sidebar), so it lives in localStorage and works without it. */
const MODULE_KEY = 'fp.module'
const readModule = (): string | undefined => { try { return localStorage.getItem(MODULE_KEY) ?? undefined } catch { return undefined } }
const saveModule = (id: string) => { try { localStorage.setItem(MODULE_KEY, id) } catch { /* private mode */ } }

type Phase = 'booting' | 'setup' | 'login' | 'ready' | 'error' | 'portal' | 'join'
interface AppState {
  phase: Phase; db: Db | null; ctx: Ctx | null; rev: number; error?: string; fieldMode: boolean; module?: string
  setModule(id: string): void
  boot(): Promise<void>; afterSetup(): void; signedIn(ctx: Omit<Ctx, 'db'>, resumed?: boolean): void; signOut(): void; bump(): void; openPortal(): void; openJoin(): void; leavePortal(): void; setFieldMode(on: boolean): void
}

export const useApp = create<AppState>((set, get) => ({
  phase: 'booting', db: null, ctx: null, rev: 0, fieldMode: false, module: readModule(),
  setModule(id) { saveModule(id); set(s => ({ module: id, ctx: s.ctx ? { ...s.ctx, module: id } : s.ctx, rev: s.rev + 1 })) },
  async boot() {
    try {
      // The wasm is imported as a URL so the bundler ships exactly the file the installed sql.js asks for (newer sql.js versions use a different file name in browsers).
      const db = await Db.open(new IndexedDbPersistence(), f => f.endsWith('.wasm') ? wasmUrl : `${import.meta.env.BASE_URL}${f}`)
      if (!isInitialised(db)) { set({ db, phase: 'setup' }); clearSession() }
      else { const uid = readSession(); const c = uid ? resumeSession(db, uid) : null; set({ db, phase: 'login' }); if (c) get().signedIn(c, true); else clearSession() }
      window.addEventListener('beforeunload', () => { void db.flush() })
    } catch (e) { set({ phase: 'error', error: e instanceof Error ? e.message : String(e) }) }
  },
  afterSetup() { set({ phase: 'login' }) },
  signedIn(c, resumed = false) {
    const db = get().db!
    // A fresh sign-in opens the Dashboard; a reload stays on the page it was on.
    if (!resumed) try { if (window.location.hash && window.location.hash !== '#/') history.replaceState(null, '', '#/') } catch { /* no history API */ }
    if (c.actor) saveSession(c.actor.id)
    set({ ctx: { db, ...c, module: get().module }, phase: 'ready', fieldMode: deviceTag(db) !== '' }) },
  signOut() { clearSession(); const db = get().db; if (db) db.actor = null; set({ ctx: null, phase: 'login', fieldMode: false }) },
  openJoin() { set({ phase: 'join' }) },
  setFieldMode(on) { set({ fieldMode: on }) },
  openPortal() { set({ phase: 'portal' }) },
  leavePortal() { const db = get().db; set({ phase: db && isInitialised(db) ? 'login' : 'setup' }) },
  bump() { set(s => ({ rev: s.rev + 1 })) },
}))

export interface Toast { id: number; kind: 'ok' | 'err'; text: string }
interface ToastState { items: Toast[]; push(kind: Toast['kind'], text: string): void; dismiss(id: number): void }
let tid = 0
export const useToasts = create<ToastState>(set => ({
  items: [],
  push(kind, text) { const id = ++tid; set(s => ({ items: [...s.items, { id, kind, text }] })); setTimeout(() => set(s => ({ items: s.items.filter(t => t.id !== id) })), kind === 'err' ? 7000 : 3000) },
  dismiss(id) { set(s => ({ items: s.items.filter(t => t.id !== id) })) },
}))
